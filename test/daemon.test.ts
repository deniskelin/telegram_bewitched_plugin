/**
 * End-to-end: real daemon (in-process) + fake Bot API + a fake session client
 * over the unix socket. No real Telegram traffic.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { callbackQuery, textMessage } from './fake-telegram.ts'
import { fakeTelegram as tg } from './setup.ts'

const { Daemon } = await import('../src/daemon/daemon.ts')
const { registerInbound, handlePermissionRequest } = await import('../src/daemon/inbound.ts')
const { registerTopicCommands, onSessionRegistered, onSessionGone, scheduleDashboard, connectGroup } = await import('../src/daemon/topics.ts')
const { handleCall } = await import('../src/daemon/tools.ts')
const { registerLaunchCommands } = await import('../src/daemon/launch.ts')
const { startHttp } = await import('../src/daemon/http.ts')
const { LineDecoder, encode } = await import('../src/ipc.ts')
const { SOCK_FILE, httpToken, settings } = await import('../src/config.ts')
const { prefsFor, setPref } = await import('../src/access.ts')

type Inbound = { t: 'inbound'; content: string; meta: Record<string, string> }

class FakeClient {
  msgs: Record<string, unknown>[] = []
  sock!: Awaited<ReturnType<typeof Bun.connect>>
  private dec = new LineDecoder()
  private id = 1

  async connect(hello: Record<string, unknown>): Promise<string> {
    this.sock = await Bun.connect({
      unix: SOCK_FILE,
      socket: {
        data: (_s, chunk) => {
          for (const m of this.dec.push(chunk.toString())) this.msgs.push(m as Record<string, unknown>)
        },
      },
    })
    this.sock.write(encode({ t: 'hello', protocol: 1, claudePid: null, cwd: '/tmp/proj', projectRoot: '/tmp/proj', branch: 'main', tmuxPane: null, passive: false, ...hello } as never))
    const w = await this.wait(m => m.t === 'welcome')
    return String(w.session)
  }

  async wait(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const i = this.msgs.findIndex(pred)
      if (i >= 0) return this.msgs.splice(i, 1)[0]
      await Bun.sleep(20)
    }
    throw new Error(`timeout; have ${JSON.stringify(this.msgs)}`)
  }

  inbound(pred: (m: Inbound) => boolean = () => true): Promise<Inbound> {
    return this.wait(m => m.t === 'inbound' && pred(m as Inbound)) as Promise<Inbound>
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const id = this.id++
    this.sock.write(encode({ t: 'call', id, name, args }))
    const r = await this.wait(m => m.t === 'result' && m.id === id)
    return { ok: Boolean(r.ok), text: String(r.text) }
  }

  close(): void {
    this.sock.end()
  }
}

const d = new Daemon('123:TEST', ':memory:')
d.onSessionRegistered = s => onSessionRegistered(d, s)
d.onSessionGone = s => onSessionGone(d, s)
d.onSessionsChanged = () => scheduleDashboard(d)
d.handleCall = (s, n, a) => handleCall(d, s, n, a)
d.handlePermissionRequest = (s, p) => handlePermissionRequest(d, s, p)
const launched: string[] = []
d.launchSession = async dir => { launched.push(dir); return '3' }

const client = new FakeClient()
let sessionId = ''
const mainDir = process.env.MAIN_DIR!
let main = new FakeClient()

beforeAll(async () => {
  d.listen()
  startHttp(d)
  void d.startPolling(bot => {
    registerTopicCommands(d, bot)
    registerLaunchCommands(d, bot)
    registerInbound(d, bot, '123:TEST')
  })
  await tg.waitFor('getMe')
  sessionId = await client.connect({ claudePid: 424242 })
})

afterAll(async () => {
  client.close()
  main.close()
  await d.bot.stop()
  tg.stop()
})

describe('DM flow', () => {
  test('DM without a main session is queued and reaches the main session when it connects', async () => {
    tg.push(textMessage({ text: 'есть кто?' }))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('💤 Главная сессия не запущена'))
    await main.connect({ cwd: mainDir, projectRoot: null, claudePid: 777 })
    const resume = await main.inbound(x => x.meta.event === 'session_resume')
    expect(resume.content).toContain('есть кто?')
    expect(resume.meta.pending_count).toBe('1')
    expect(client.msgs.some(m => m.t === 'inbound')).toBe(false)
  })

  test('inbound DM reaches the main session, not the project session, and opens a draft stream', async () => {
    tg.push(textMessage({ text: 'привет' }))
    const m = await main.inbound(x => x.content === 'привет')
    expect(m.meta.chat_id).toBe('111')
    expect(m.meta.user).toBe('den')
    await tg.waitFor('sendMessageDraft')
    expect(client.msgs.some(x => x.t === 'inbound')).toBe(false)
  })

  test('reply sends the answer and records history', async () => {
    const r = await main.call('reply', { chat_id: '111', text: 'ответ' })
    expect(r.ok).toBe(true)
    await tg.waitFor('sendMessage', c => c.body.text === 'ответ')
    const h = await main.call('get_history', { chat_id: '111' })
    expect(h.text).toContain('привет')
    expect(h.text).toContain('bot: ответ')
  })

  test('non-allowlisted sender is dropped', async () => {
    tg.push(textMessage({ from: 222, text: 'чужой' }))
    await Bun.sleep(300)
    expect(main.msgs.some(m => m.t === 'inbound' && (m as Inbound).content === 'чужой')).toBe(false)
  })

  test('reply-to and quote are enriched', async () => {
    tg.push(textMessage({ text: 'а это?', replyTo: { message_id: 1000, date: 0, chat: { id: 111, type: 'private' }, from: { id: 999, is_bot: true, first_name: 'Test' }, text: 'исходное сообщение бота' }, extra: { quote: { text: 'исходное', position: 0 } } }))
    const m = await main.inbound(x => x.content === 'а это?')
    expect(m.meta.reply_to_from).toBe('bot')
    expect(m.meta.reply_to_text).toBe('исходное сообщение бота')
    expect(m.meta.quote_text).toBe('исходное')
  })

  test('passive sessions never receive inbound messages', async () => {
    const passive = new FakeClient()
    await passive.connect({ passive: true, claudePid: 1 })
    tg.push(textMessage({ text: 'только активной' }))
    await main.inbound(x => x.content === 'только активной')
    expect(passive.msgs.some(m => m.t === 'inbound')).toBe(false)
    const r = await passive.call('reply', { chat_id: '111', text: 'x' })
    expect(r.ok).toBe(false)
    passive.close()
  })
})

describe('buttons', () => {
  test('ask_user posts buttons and a tap comes back as an answer event', async () => {
    const r = await client.call('ask_user', { chat_id: '111', text: 'Ставим?', options: ['Да', 'Нет'] })
    expect(r.ok).toBe(true)
    const qid = /question_id: ([0-9a-f]{8})/.exec(r.text)![1]
    const sent = await tg.waitFor('sendMessage', c => c.body.text === 'Ставим?')
    const kb = (sent.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard
    expect(kb.flat().map(b => b.callback_data)).toEqual([`q:${qid}:0`, `q:${qid}:1`])

    tg.push(callbackQuery(`q:${qid}:1`, { from: 222 }))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Нет доступа.')

    tg.push(callbackQuery(`q:${qid}:1`))
    const m = await client.inbound(x => x.meta.event === 'answer')
    expect(m.content).toBe('Нет')
    expect(m.meta.question_id).toBe(qid)
    expect(m.meta.option_index).toBe('1')

    tg.push(callbackQuery(`q:${qid}:0`))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === 'На этот вопрос уже ответили.')
  })
})

describe('topics', () => {
  const group = '-100500'

  test('connecting a group creates a project topic and pins the dashboard', async () => {
    await connectGroup(d, group)
    const t = await tg.waitFor('createForumTopic', c => c.body.name === 'proj')
    expect(t.body.chat_id).toBe(group)
    await tg.waitFor('pinChatMessage', () => true, 12_000)
    expect(d.sessions.get(sessionId)!.topic?.name).toBe('proj')
  }, 15_000)

  test('message in the topic routes to the session; progress message + hook lines + delete on reply', async () => {
    const thread = d.sessions.get(sessionId)!.topic!.threadId
    tg.push(textMessage({ chat: Number(group), text: 'сделай тесты', thread }))
    const m = await client.inbound(x => x.content === 'сделай тесты')
    expect(m.meta.thread_id).toBe(String(thread))
    expect(m.meta.topic_name).toBe('proj')
    const progress = await tg.waitFor('sendMessage', c => c.body.text === '⏳ Работаю… · 🔔1')
    expect(JSON.stringify(progress.body.reply_markup)).toContain(`stop:${sessionId}`)

    const res = await fetch(`http://127.0.0.1:${settings.httpPort}/hook`, {
      method: 'POST',
      headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'PreToolUse', claudePid: 424242, data: { tool_name: 'Bash', tool_input: { command: 'bun test', description: 'Run tests' } } }),
    })
    expect(res.status).toBe(200)
    await tg.waitFor('editMessageText', c => String(c.body.text).includes('💻 Run tests'))

    const r = await client.call('reply', { chat_id: group, text: 'готово' })
    expect(r.ok).toBe(true)
    const ans = await tg.waitFor('sendMessage', c => c.body.text === 'готово')
    expect(ans.body.message_thread_id).toBe(thread)
    await tg.waitFor('deleteMessage')
  })

  test('topic without a session goes to the main session; the project session later sees it as handled', async () => {
    const other = new FakeClient()
    await other.connect({ cwd: '/tmp/other', projectRoot: '/tmp/other', claudePid: 5 })
    await tg.waitFor('createForumTopic', c => c.body.name === 'other')
    other.close()
    await Bun.sleep(200)
    const thread = Number((d.store.topicForProject(group, '/tmp/other'))!.thread_id)
    tg.push(textMessage({ chat: Number(group), text: 'ты тут?', thread }))
    const m = await main.inbound(x => x.content === 'ты тут?')
    expect(m.meta.thread_id).toBe(String(thread))
    const r = await main.call('reply', { chat_id: group, message_thread_id: String(thread), text: 'я за него' })
    expect(r.ok).toBe(true)
    const ans = await tg.waitFor('sendMessage', c => c.body.text === 'я за него')
    expect(ans.body.message_thread_id).toBe(thread)

    const again = new FakeClient()
    await again.connect({ cwd: '/tmp/other', projectRoot: '/tmp/other', claudePid: 6 })
    const resume = await again.inbound(x => x.meta.event === 'session_resume')
    expect(resume.content).toContain('уже ответила главная сессия')
    expect(resume.content).toContain('ты тут?')
    expect(resume.meta.pending_count).toBe('0')
    again.close()
  })

  test('without a main session an offline topic queues messages and delivers them on reconnect', async () => {
    main.close()
    await Bun.sleep(200)
    const thread = Number((d.store.topicForProject(group, '/tmp/other'))!.thread_id)
    tg.push(textMessage({ chat: Number(group), text: 'а теперь?', thread }))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('💤 Сессия этого проекта'))

    const again = new FakeClient()
    await again.connect({ cwd: '/tmp/other', projectRoot: '/tmp/other', claudePid: 7 })
    const resume = await again.inbound(x => x.meta.event === 'session_resume')
    expect(resume.content).toContain('а теперь?')
    expect(resume.meta.pending_count).toBe('1')
    again.close()
    main = new FakeClient()
    await main.connect({ cwd: mainDir, projectRoot: null, claudePid: 778 })
  })

  test('General: text goes to the main session, unknown commands do not; the main session has no topic', async () => {
    tg.push(textMessage({ chat: Number(group), text: 'общий вопрос' }))
    const m = await main.inbound(x => x.content === 'общий вопрос')
    expect(m.meta.thread_id).toBeUndefined()
    tg.push(textMessage({ chat: Number(group), text: '/nope' }))
    await Bun.sleep(300)
    expect(main.msgs.some(x => x.t === 'inbound' && (x as Inbound).content === '/nope')).toBe(false)
    expect(d.store.topicForProject(group, mainDir)).toBeFalsy()
  })

  test('/main <id> makes another session the main one; /main reset returns to MAIN_DIR', async () => {
    tg.push(textMessage({ text: `/main ${sessionId}` }))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith(`👑 Главная сессия теперь #${sessionId}`))
    tg.push(textMessage({ text: 'теперь тебе' }))
    await client.inbound(x => x.content === 'теперь тебе')
    tg.push(textMessage({ text: '/main reset' }))
    await tg.waitFor('sendMessage', c => String(c.body.text).includes('снова по MAIN_DIR'))
    tg.push(textMessage({ text: 'снова главной' }))
    await main.inbound(x => x.content === 'снова главной')
  })

  test('session card has the tmux target, RC, model; /topics is a menu of topics; 👁 screen', async () => {
    d.tmuxLocation = async p => (p === '%9' ? { session: 'work', window: '2', windowName: 'tmuxed', pane: '0', tail: '> \n  ? for shortcuts   /rc active\n' } : null)
    const t = new FakeClient()
    await t.connect({ cwd: '/tmp/tmuxed', projectRoot: '/tmp/tmuxed', tmuxPane: '%9', branch: 'feat', claudePid: 99 })
    await tg.waitFor('createForumTopic', c => c.body.name === 'tmuxed')
    const { mkdtempSync, writeFileSync } = await import('fs')
    const { tmpdir } = await import('os')
    const transcript = `${mkdtempSync(`${tmpdir()}/tr-`)}/abc.jsonl`
    writeFileSync(transcript, [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0, output_tokens: 0 } } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5', usage: { input_tokens: 5 } } }),
      JSON.stringify({ type: 'custom-title', customTitle: 'my-box' }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'remote_session_change', url: 'https://claude.ai/code/session_X' } }),
    ].join('\n') + '\n')
    await fetch(`http://127.0.0.1:${settings.httpPort}/hook`, {
      method: 'POST',
      headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'PreToolUse', claudePid: 99, data: { session_id: 'abc-123', transcript_path: transcript, permission_mode: 'plan', tool_name: 'Bash', tool_input: { command: 'ls', description: 'List files' } } }),
    })
    // The session card (from the /sessions menu) has everything about the session.
    const tmuxed = [...d.sessions.values()].find(x => x.projectKey === '/tmp/tmuxed')!
    tg.push(callbackQuery(`sm:s:${tmuxed.id}`))
    const c1 = await tg.waitFor('editMessageText', c => String(c.body.text).includes('📂 <b>tmuxed</b>'))
    const text = String(c1.body.text)
    expect(c1.body.parse_mode).toBe('HTML')
    expect(text).toContain('📂 <b>tmuxed</b> «my-box» · 🔵 работает')
    expect(text).toContain('🌿 feat · 💬 <a href=')
    expect(text).toContain('<blockquote>🖥 <code>tmux attach -t work:2</code>\n🛡 plan · ⏹ стоп · 📱 <a href="https://claude.ai/code/session_X">RC вкл</a>\n📣 🔔1 · ✅ после долгих ходов\n🧠 opus-5-5 · 90k из 1M (9%)\n🔧 💻 List files</blockquote>')
    expect(text).toContain('<blockquote expandable>🆔')
    expect(text).toContain('🖥 сессия work · окно 2 «tmuxed» · панель 0')
    expect(text).toContain('🧾 <code>claude --resume abc-123</code>')
    tg.push(callbackQuery(`sm:s:${sessionId}`))
    const c2 = await tg.waitFor('editMessageText', c => String(c.body.text).includes(`#${sessionId}`) && String(c.body.text).includes('📂 <b>proj</b>'))
    expect(String(c2.body.text)).toContain('🖥 не в tmux')
    expect(String(c2.body.text)).toContain('📱 RC ?')

    // /topics: a menu of topics; the one without a session can be started from its screen.
    tg.push(textMessage({ text: '/topics' }))
    const r = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('📂 <b>Топики</b>'))
    expect(String(r.body.text)).toContain('📁 <b>tmuxed</b> · 🔵 работает')
    expect(String(r.body.text)).toContain('📁 <b>other</b> · 💤 без сессии')
    const otherThread = d.store.topicForProject(group, '/tmp/other')!.thread_id
    expect(JSON.stringify(r.body.reply_markup)).toContain(`tm:t:${otherThread}`)
    tg.push(callbackQuery(`tm:t:${otherThread}`))
    const ts = await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('📁 <b>other</b>'))
    expect(String(ts.body.text)).toContain('<code>/tmp/other</code>')
    expect(JSON.stringify(ts.body.reply_markup)).toContain(`tm:run:${otherThread}`)
    expect(JSON.stringify(ts.body.reply_markup)).toContain(`tm:ar:${otherThread}`)
    tg.push(callbackQuery(`tm:del:${otherThread}`))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('Удалить топик «other»'))
    tg.push(callbackQuery(`tm:t:${otherThread}`))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('📁 <b>other</b>') && tg.callsOf('editMessageText').length > 0)
    expect(d.store.topic(group, otherThread)).toBeTruthy()

    // 👁 screen of its pane with keys; the keys go to tmux, the screen is captured again.
    const pressed: string[][] = []
    d.tmuxCapture = async t => (t === '%9' ? 'Load development channels?\n❯ 1. Yes\n  2. No\n\n\n' : null)
    d.tmuxKeys = async (t, k) => { pressed.push([t, ...k]) }
    expect(JSON.stringify(c1.body.reply_markup)).toContain('tx:p9')
    tg.push(callbackQuery('tx:p9'))
    const scr = await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('🖥 <b>Экран</b> <code>%9</code>'))
    expect(String(scr.body.text)).toContain('<pre>Load development channels?\n❯ 1. Yes\n  2. No</pre>')
    expect(JSON.stringify(scr.body.reply_markup)).toContain(`sm:s:${tmuxed.id}`)
    tg.push(callbackQuery('tx:p9:e'))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Нажато: ⏎ Enter')
    expect(pressed).toEqual([['%9', 'Enter']])
    tg.push(callbackQuery('tx:p9;rm', {}))
    tg.push(callbackQuery('tx:p9:e', { from: 222 }))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Нет доступа.')
    expect(pressed.length).toBe(1)
    t.close()
  })

  test('/usage: plan, limits from the endpoint, tokens and API cost by model and session', async () => {
    const cfg = process.env.CLAUDE_CONFIG_DIR!
    mkdirSync(join(cfg, 'projects', '-tmp-proj', 's1', 'subagents'), { recursive: true })
    writeFileSync(join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 3600_000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }))
    const now = new Date().toISOString()
    const reply = (id: string, model: string, cwd: string, usage: Record<string, unknown>) =>
      JSON.stringify({ type: 'assistant', timestamp: now, cwd, requestId: `r${id}`, message: { id, model, usage } })
    const u = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 }
    // Two lines of one reply count once; a later `cd` stays in the session's folder.
    writeFileSync(join(cfg, 'projects', '-tmp-proj', 's1.jsonl'), [
      reply('m1', 'claude-opus-5-5', '/tmp/proj', u), reply('m1', 'claude-opus-5-5', '/tmp/proj', u),
      reply('m2', 'claude-opus-5-5', '/tmp/proj/sub', u), '{broken',
    ].join('\n'))
    writeFileSync(join(cfg, 'projects', '-tmp-proj', 's1', 'subagents', 'a.jsonl'), reply('m3', 'claude-haiku-5-5', '/tmp/proj', u))
    let auth = ''
    const api = Bun.serve({
      port: 0,
      fetch: req => {
        auth = req.headers.get('authorization') ?? ''
        return Response.json({ limits: [
          { kind: 'session', percent: 42, resets_at: new Date(Date.now() + 3600_000).toISOString() },
          { kind: 'weekly_all', percent: 7, resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() },
        ], seven_day_breakdown: { rows: [{ display_name: 'Claude Code', percent: 90 }, { display_name: 'Chats', percent: 10 }] } })
      },
    })
    process.env.USAGE_API_URL = `http://127.0.0.1:${api.port}/`
    try {
      tg.push(textMessage({ text: '/usage' }))
      const r = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('📊'))
      const text = String(r.body.text)
      expect(auth).toBe('Bearer tok')
      expect(text).toContain('Подписка</b>: Max 20x')
      expect(text).toContain('5 часов: <b>42%</b> ▰▰▰▰▱▱▱▱▱▱')
      expect(text).toContain('Неделя: <b>7%</b>')
      expect(text).toContain('через 3 д')
      expect(text).toContain('За неделю: Claude Code 90%, Chats 10%')
      // opus: 2 × (1000·4 + 1000·20 + 1M·0.2)/1M = $0.448; haiku: (1000·0.5 + 1000·2.5 + 1M·0.05)/1M = $0.053
      expect(text).toContain('opus-5-5: 2.0 млн ток. · $0.45')
      expect(text).toContain('haiku-5-5: 1.0 млн ток. · $0.05')
      expect(text).toContain('📂 proj: 3.0 млн ток. · $0.50')
      expect(text).not.toContain('📂 sub')
      // The same replies: today's cost in the session card and in the daily digest.
      const { sessionCostLine, digestReport } = await import('../src/daemon/usage.ts')
      expect(sessionCostLine(d.sessions.get(sessionId)!)).toBe('💸 сегодня $0.50 · 3.0 млн ток.')
      const digest = await digestReport(d)
      expect(digest).toStartWith('🌙 <b>Итоги дня</b>')
      expect(digest).toContain('📂 proj · $0.50')

      // Period reports: off by default; switched on, the day report goes out once after midnight.
      const { sendDueReports } = await import('../src/daemon/reports.ts')
      tg.push(textMessage({ text: '/reports' }))
      const rs = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('📊 <b>Отчёты о потреблении</b>'))
      expect(String(rs.body.text)).toContain('⬜️ За сутки')
      tg.push(callbackQuery('rp:t:day'))
      await tg.waitFor('editMessageText', c => String(c.body.text).includes('✅ За сутки'))
      const tomorrow = new Date(Date.now() + 86_400_000)
      tomorrow.setHours(0, 30, 0, 0)
      const photos = () => tg.callsOf('sendPhoto').length
      const before = photos()
      await sendDueReports(d, tomorrow)
      expect(photos()).toBe(before + 1)
      const rep = tg.callsOf('sendMessage').at(-1)!
      expect(String(rep.body.text)).toStartWith('📊 <b>Статистика за сутки</b>')
      expect(String(rep.body.text)).toContain('💸 3.0 млн ток. · $0.50')
      expect(String(rep.body.text)).toContain('• 📂 proj: $0.50')
      await sendDueReports(d, tomorrow)
      expect(photos()).toBe(before + 1)
      tg.push(callbackQuery('rp:now:week'))
      await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('📊 <b>Статистика за неделю</b>'))
      expect(photos()).toBe(before + 2)
      tg.push(callbackQuery('rp:t:day'))
      await tg.waitFor('editMessageText', c => String(c.body.text).includes('⬜️ За сутки'))
    } finally {
      api.stop()
      delete process.env.USAGE_API_URL
    }
    // Someone else in the DM gets nothing.
    const before = tg.callsOf('sendMessage').length
    tg.push(textMessage({ text: '/usage', from: 222 }))
    await Bun.sleep(300)
    expect(tg.callsOf('sendMessage').length).toBe(before)
  })

  test('session control: /compact, /clear after confirmation, /model typed into the pane; context notice once', async () => {
    const { checkContext } = await import('../src/daemon/menu.ts')
    const { mkdtempSync } = await import('fs')
    const { tmpdir } = await import('os')
    const c = new FakeClient()
    await c.connect({ cwd: '/tmp/ctl', projectRoot: '/tmp/ctl', tmuxPane: '%11', claudePid: 1212 })
    await tg.waitFor('createForumTopic', x => x.body.name === 'ctl')
    const s = [...d.sessions.values()].find(x => x.projectKey === '/tmp/ctl')!
    const typed: string[] = []
    d.tmuxType = async (t, text) => { typed.push(`${t} ${text}`) }

    tg.push(callbackQuery(`sm:cmp:${s.id}`))
    await tg.waitFor('answerCallbackQuery', x => x.body.text === '➡️ /compact')
    tg.push(callbackQuery(`sm:clr:${s.id}`))
    await tg.waitFor('editMessageText', x => String(x.body.text).startsWith(`Очистить разговор сессии #${s.id}`))
    expect(typed).toEqual(['%11 /compact'])
    tg.push(callbackQuery(`sm:clrok:${s.id}`))
    await tg.waitFor('answerCallbackQuery', x => x.body.text === '➡️ /clear')
    tg.push(callbackQuery(`sm:mdl:${s.id}`))
    const models = await tg.waitFor('editMessageText', x => String(x.body.text).startsWith('🧠 Модель'))
    expect(JSON.stringify(models.body.reply_markup)).toContain(`sm:model:${s.id}:sonnet`)
    tg.push(callbackQuery(`sm:model:${s.id}:sonnet`))
    await tg.waitFor('answerCallbackQuery', x => x.body.text === '➡️ /model claude-sonnet-5-5')
    s.status = 'working'
    tg.push(callbackQuery(`sm:cmp:${s.id}`))
    await tg.waitFor('answerCallbackQuery', x => String(x.body.text).startsWith('Сессия работает'))
    s.status = 'idle'
    expect(typed).toEqual(['%11 /compact', '%11 /clear', '%11 /model claude-sonnet-5-5'])

    // 90k of a 100k window: one notice with a /compact button.
    const tr = `${mkdtempSync(`${tmpdir()}/ctx-`)}/t.jsonl`
    writeFileSync(tr, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 0, cache_read_input_tokens: 90_000, output_tokens: 0 } } }) + '\n')
    s.claude.transcript = tr
    process.env.CONTEXT_WINDOW = '100000'
    try {
      await checkContext(d, s)
      await checkContext(d, s)
      const notes = tg.callsOf('sendMessage').filter(x => String(x.body.text).includes('Контекст сессии') && String(x.body.text).includes(`#${s.id}`))
      expect(notes.length).toBe(1)
      expect(String(notes[0].body.text)).toContain('заполнен на <b>90%</b>')
      expect(notes[0].body.message_thread_id).toBe(s.topic!.threadId)
      const edits = tg.callsOf('editMessageReplyMarkup').length
      tg.push(callbackQuery(`sm:cmpn:${s.id}`))
      await tg.waitFor('editMessageReplyMarkup', () => tg.callsOf('editMessageReplyMarkup').length > edits)
      expect(typed.at(-1)).toBe('%11 /compact')
    } finally {
      delete process.env.CONTEXT_WINDOW
      c.close()
    }
  })

  test('🌿 git: status, last commits, diff as a file', async () => {
    const { mkdtempSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { execFileSync } = await import('child_process')
    const repo = mkdtempSync(`${tmpdir()}/repo-`)
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git('add', '.')
    git('commit', '-qm', 'first commit')
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    const c = new FakeClient()
    await c.connect({ cwd: repo, projectRoot: repo, branch: 'main', claudePid: 1313 })
    const s = [...d.sessions.values()].find(x => x.projectKey === repo)!
    try {
      tg.push(callbackQuery(`sm:git:${s.id}`))
      const g = await tg.waitFor('editMessageText', x => String(x.body.text).startsWith('🌿 <b>Git</b>') && String(x.body.text).includes(s.projectName))
      expect(String(g.body.text)).toContain('M a.txt')
      expect(String(g.body.text)).toContain('first commit')
      tg.push(callbackQuery(`sm:gdf:${s.id}`))
      const doc = await tg.waitFor('sendDocument', x => String(x.body.caption ?? '').includes(s.projectName))
      expect(String(doc.body.caption)).toContain('1 файл')
    } finally {
      c.close()
    }
  })

  test('limit alerts: one notice per threshold crossed, a notice when the window resets; dashboard line', async () => {
    const { checkLimits, resetLimitsCache } = await import('../src/daemon/usage.ts')
    const { renderDashboard } = await import('../src/daemon/topics.ts')
    let percent = 50
    let resets = Date.now() + 3600_000
    const api = Bun.serve({ port: 0, fetch: () => Response.json({ limits: [{ kind: 'session', percent, resets_at: new Date(resets).toISOString() }] }) })
    process.env.USAGE_API_URL = `http://127.0.0.1:${api.port}/`
    const notices = () => tg.callsOf('sendMessage').filter(c => /Лимит «5 часов»/.test(String(c.body.text))).map(c => String(c.body.text).split('\n')[0])
    const check = async (p: number) => { percent = p; resetLimitsCache(); await checkLimits(d) }
    try {
      await check(50)
      await check(85)
      await check(87)
      await check(96)
      resets += 5 * 3600_000
      await check(4)
      await check(3)
      expect(notices()).toEqual([
        '⚠️ Лимит «5 часов»: <b>85%</b> ▰▰▰▰▰▰▰▰▰▱',
        '🚨 Лимит «5 часов»: <b>96%</b> ▰▰▰▰▰▰▰▰▰▰',
        '✅ Лимит «5 часов» восстановился: 4% ▱▱▱▱▱▱▱▱▱▱',
      ])
      expect(renderDashboard(d)).toContain('📊 5 часов 3%')
    } finally {
      api.stop()
      delete process.env.USAGE_API_URL
      resetLimitsCache()
    }
  })

  test('/verbose without an argument shows the level; with one sets it', async () => {
    tg.push(textMessage({ text: '/verbose' }))
    const r = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('Здесь: 🔔1 · ✅ после долгих ходов'))
    expect(String(r.body.text)).toContain('📢2 + текст модели')
    tg.push(textMessage({ text: '/verbose 2' }))
    await tg.waitFor('sendMessage', c => c.body.text === 'Подробность прогресса: 📢2 + текст модели')
    tg.push(textMessage({ text: '/notify_done' }))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('Здесь: ✅ после долгих ходов'))
    tg.push(textMessage({ text: '/verbose 1' }))
    await tg.waitFor('sendMessage', c => c.body.text === 'Подробность прогресса: 🔔1 + действия')
  })

  test('/sessions lists sessions without the channel and how to restart them', async () => {
    const p = new FakeClient()
    await p.connect({ cwd: '/tmp/nochan', projectRoot: '/tmp/nochan', passive: true, claudePid: process.ppid })
    tg.push(textMessage({ text: '/sessions' }))
    const r = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('📋 <b>Сессии</b>') && String(c.body.text).includes('nochan'))
    const text = String(r.body.text)
    expect(text).toContain('👻 <b>Без канала</b> (1)')
    expect(text).toContain('без канала')
    expect(text).toContain(`<code>${settings.launchCmd} `)
    expect(text.indexOf('👻')).toBeGreaterThan(text.indexOf('👑 <b>Главная</b>'))
    p.close()
  })

  test('/sessions is a menu: a session button opens its card, settings apply to its topic, « returns', async () => {
    tg.push(textMessage({ text: '/sessions' }))
    const r = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('📋 <b>Сессии</b>') && String(c.body.text).includes('Выберите сессию'))
    expect(String(r.body.text)).toContain('📂 <b>proj</b> · ')
    const kb = JSON.stringify(r.body.reply_markup)
    expect(kb).toContain(`sm:s:${sessionId}`)
    expect(kb).toContain('sm:list')

    const s = d.sessions.get(sessionId)!
    const key = `${s.topic!.chatId}:${s.topic!.threadId}`
    tg.push(callbackQuery(`sm:s:${sessionId}`))
    const card = await tg.waitFor('editMessageText', c => String(c.body.text).includes(`#${sessionId}`) && String(c.body.text).includes('в топике'))
    expect(String(card.body.text)).toContain('📂 <b>proj</b>')
    const ckb = JSON.stringify(card.body.reply_markup)
    expect(ckb).toContain(`sm:v:${sessionId}:2`)
    expect(ckb).toContain(`sm:n:${sessionId}:always`)
    expect(ckb).toContain(`sm:ar:${sessionId}`)
    expect(ckb).toContain('• 🔔1')

    tg.push(callbackQuery(`sm:v:${sessionId}:2`))
    await tg.waitFor('editMessageText', c => JSON.stringify(c.body.reply_markup ?? '').includes('• 📢2'))
    expect(prefsFor(s.topic!.chatId, s.topic!.threadId).verbose).toBe(2)
    tg.push(callbackQuery(`sm:n:${sessionId}:always`))
    await tg.waitFor('editMessageText', c => JSON.stringify(c.body.reply_markup ?? '').includes('• ✅ всегда'))
    expect(prefsFor(s.topic!.chatId, s.topic!.threadId).notifyDone).toBe('always')
    setPref(key, { verbose: 1, notifyDone: 'long' })

    tg.push(callbackQuery(`sm:ar:${sessionId}`))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('Архивировать «proj»'))
    tg.push(callbackQuery(`sm:s:${sessionId}`))
    await tg.waitFor('editMessageText', c => String(c.body.text).includes(`#${sessionId}`) && JSON.stringify(c.body.reply_markup ?? '').includes('sm:list'))
    tg.push(callbackQuery('sm:list'))
    await tg.waitFor('editMessageText', c => String(c.body.text).includes('Выберите сессию'))
    expect(d.store.topic(s.topic!.chatId, s.topic!.threadId)?.status).toBe('active')

    // Someone else can't use the menu.
    tg.push(callbackQuery(`sm:v:${sessionId}:0`, { from: 222 }))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Нет доступа.')
    expect(prefsFor(s.topic!.chatId, s.topic!.threadId).verbose).toBe(1)
  })

  test('notify over HTTP reaches a topic by name; bad token is rejected', async () => {
    const url = `http://127.0.0.1:${settings.httpPort}/notify`
    const bad = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })
    expect(bad.status).toBe(401)
    const ok = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'сборка упала', topic: 'proj' }),
    })
    expect(ok.status).toBe(200)
    const c = await tg.waitFor('sendMessage', x => x.body.text === 'сборка упала')
    expect(c.body.message_thread_id).toBe(d.sessions.get(sessionId)!.topic!.threadId)
  })

  test('long turn without reply sends a done notice on Stop', async () => {
    const hook = (event: string, data: Record<string, unknown>) => fetch(`http://127.0.0.1:${settings.httpPort}/hook`, {
      method: 'POST',
      headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event, claudePid: 424242, data }),
    })
    await hook('Stop', {}) // end the previous (replied) turn
    await hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x/y.ts' } })
    await hook('Stop', { last_assistant_message: 'Всё сделал, тесты зелёные.' })
    const c = await tg.waitFor('sendMessage', x => String(x.body.text).startsWith('✅ Готово за'))
    expect(String(c.body.text)).toContain('тесты зелёные')
  })

  test('permission request goes to the strict topic and the verdict returns to the session', async () => {
    client.sock.write(encode({ t: 'perm_req', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: '{"command":"ls"}' }))
    const msg = await tg.waitFor('sendMessage', c => c.body.text === '🔐 proj: Bash')
    expect(msg.body.chat_id).toBe(group)
    tg.push(callbackQuery('perm:allow:abcde', { chat: Number(group) }))
    const v = await client.wait(m => m.t === 'perm')
    expect(v).toEqual({ t: 'perm', request_id: 'abcde', behavior: 'allow' })
  })

  test('♾ always: later requests for the tool are allowed silently; /permissions lists waiting ones; reset in the card', async () => {
    const asks = () => tg.callsOf('sendMessage').filter(c => String(c.body.text).startsWith('🔐 proj: ')).length
    client.sock.write(encode({ t: 'perm_req', request_id: 'bcdef', tool_name: 'Edit', description: 'edit a.ts', input_preview: '{}' }))
    const msg = await tg.waitFor('sendMessage', c => c.body.text === '🔐 proj: Edit')
    expect(JSON.stringify(msg.body.reply_markup)).toContain('perm:always:bcdef')

    tg.push(textMessage({ text: '/permissions' }))
    const list = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('🔐 <b>Ждут разрешения</b> (1)'))
    expect(String(list.body.text)).toContain('<b>Edit</b> — edit a.ts')
    expect(JSON.stringify(list.body.reply_markup)).toContain('perm:allow:bcdef')

    tg.push(callbackQuery('perm:always:bcdef', { chat: Number(group) }))
    expect(await client.wait(m => m.t === 'perm' && m.request_id === 'bcdef')).toMatchObject({ behavior: 'allow' })
    const before = asks()
    client.sock.write(encode({ t: 'perm_req', request_id: 'cdefg', tool_name: 'Edit', description: 'edit b.ts', input_preview: '{}' }))
    expect(await client.wait(m => m.t === 'perm' && m.request_id === 'cdefg')).toMatchObject({ behavior: 'allow' })
    expect(asks()).toBe(before)

    tg.push(callbackQuery(`sm:s:${sessionId}`))
    const card = await tg.waitFor('editMessageText', c => String(c.body.text).includes('♾ без вопросов: Edit'))
    expect(JSON.stringify(card.body.reply_markup)).toContain(`sm:aar:${sessionId}`)
    tg.push(callbackQuery(`sm:aar:${sessionId}`))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === '🔐 Разрешения снова спрашиваются')
    client.sock.write(encode({ t: 'perm_req', request_id: 'defgh', tool_name: 'Edit', description: 'edit c.ts', input_preview: '{}' }))
    await tg.waitFor('sendMessage', () => asks() > before)
    tg.push(callbackQuery('perm:deny:defgh', { chat: Number(group) }))
    expect(await client.wait(m => m.t === 'perm' && m.request_id === 'defgh')).toMatchObject({ behavior: 'deny' })
  })

  test('⏰ /remind: posted in the chat and delivered to its session when due; daily moves on; 🗑 removes; remind tool', async () => {
    const { fireDue, listReminders } = await import('../src/daemon/reminders.ts')
    const thread = d.sessions.get(sessionId)!.topic!.threadId
    tg.push(textMessage({ chat: Number(group), thread, text: '/remind 2h проверь CI' }))
    const ok = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('⏰ Напомню') && String(c.body.text).includes('проверь CI'))
    expect(ok.body.message_thread_id).toBe(thread)
    tg.push(textMessage({ chat: Number(group), thread, text: '/remind каждый день 9:00 сводка' }))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('⏰ Напомню каждый день в 09:00'))
    tg.push(textMessage({ chat: Number(group), thread, text: '/remind когда-нибудь' }))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('Формат: /remind'))

    const ci = listReminders(d).find(r => r.text === 'проверь CI')!
    await fireDue(d, ci.at + 1000)
    await tg.waitFor('sendMessage', c => c.body.text === '⏰ проверь CI' && c.body.message_thread_id === thread)
    const m = await client.inbound(x => x.meta.event === 'reminder')
    expect(m.content).toContain('проверь CI')
    expect(m.meta.thread_id).toBe(String(thread))
    expect(listReminders(d).some(r => r.id === ci.id)).toBe(false)

    const daily = listReminders(d).find(r => r.daily)!
    await fireDue(d, daily.at + 1000)
    await client.inbound(x => x.meta.event === 'reminder' && x.content.includes('сводка'))
    expect(listReminders(d).find(r => r.id === daily.id)!.at).toBe(daily.at + 86_400_000)

    tg.push(textMessage({ chat: Number(group), thread, text: '/reminders' }))
    const list = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('⏰ <b>Напоминания</b> (1)'))
    expect(JSON.stringify(list.body.reply_markup)).toContain(`rm:del:${daily.id}`)
    tg.push(callbackQuery(`rm:del:${daily.id}`, { chat: Number(group) }))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === '🗑 Напоминание удалено')
    expect(listReminders(d).length).toBe(0)

    const r = await client.call('remind', { text: 'проверь деплой', in_minutes: 5 })
    expect(r.ok).toBe(true)
    expect(listReminders(d)[0]).toMatchObject({ text: 'проверь деплой', chatId: group, threadId: thread })
    const bad = await client.call('remind', { text: 'x' })
    expect(bad.ok).toBe(false)
  })

  test('stop button without tmux only notes the stop for the next message', async () => {
    tg.push(callbackQuery(`stop:${sessionId}`, { chat: Number(group) }))
    await tg.waitFor('answerCallbackQuery', c => String(c.body.text).includes('tmux'))
    expect(d.sessions.get(sessionId)!.notes.length).toBe(1)
  })
})

describe('projects from topics', () => {
  test('a topic created by the owner becomes a project dir and launches a session', async () => {
    const group = '-100500'
    tg.push({
      message: {
        message_id: 7777, date: Math.floor(Date.now() / 1000), message_thread_id: 77, is_topic_message: true,
        from: { id: 111, is_bot: false, first_name: 'Den' },
        chat: { id: Number(group), type: 'supergroup', title: 'Test Group', is_forum: true },
        forum_topic_created: { name: 'Мой Проект!', icon_color: 7322096 },
      },
    })
    const notice = await tg.waitFor('sendMessage', c => String(c.body.text).includes('запускаю Claude в tmux'))
    expect(notice.body.message_thread_id).toBe(77)
    const dir = `${process.env.PROJECTS_DIR}/Мой-Проект`
    expect(launched).toContain(dir)
    expect(d.store.topic(group, 77)?.project_key).toBe(dir)

    // The session that starts in that dir binds to the existing topic instead of creating one.
    const before = tg.callsOf('createForumTopic').length
    const s = new FakeClient()
    await s.connect({ cwd: dir, projectRoot: dir, claudePid: 77 })
    await Bun.sleep(100)
    expect(tg.callsOf('createForumTopic').length).toBe(before)
    expect([...d.sessions.values()].find(x => x.projectKey === dir)?.topic?.threadId).toBe(77)
    s.close()
  })

  test('topics from other members are ignored', async () => {
    const n = launched.length
    tg.push({
      message: {
        message_id: 7778, date: 0, message_thread_id: 78, is_topic_message: true,
        from: { id: 222, is_bot: false, first_name: 'X' },
        chat: { id: -100500, type: 'supergroup', title: 'Test Group', is_forum: true },
        forum_topic_created: { name: 'чужой', icon_color: 7322096 },
      },
    })
    await Bun.sleep(300)
    expect(launched.length).toBe(n)
  })
})

describe('archive and restore', () => {
  const group = '-100500'

  test('archive from /sessions closes the topic, marks it 🗄 and queues later messages', async () => {
    const dir = '/tmp/arch'
    const s = new FakeClient()
    await s.connect({ cwd: dir, projectRoot: dir, claudePid: 88 })
    await tg.waitFor('createForumTopic', c => c.body.name === 'arch')
    const sess = [...d.sessions.values()].find(x => x.projectKey === dir)!
    const thread = sess.topic!.threadId

    tg.push(callbackQuery(`sm:ar:${sess.id}`, { chat: Number(group) }))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('Архивировать «arch»'))
    tg.push(callbackQuery(`sm:arok:${sess.id}`, { chat: Number(group) }))
    await tg.waitFor('closeForumTopic', c => c.body.message_thread_id === thread)
    expect(d.store.topic(group, thread)?.status).toBe('archived')
    expect(d.store.topic(group, thread)?.name).toBe('🗄 arch')
    // Not in tmux → reported as not closable.
    await tg.waitFor('editMessageText', c => String(c.body.text).includes('не в tmux'))
    s.close()
    await Bun.sleep(100)

    tg.push(textMessage({ chat: Number(group), text: 'ещё вопрос', thread }))
    const notice = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('🗄 Топик в архиве'))
    expect(JSON.stringify(notice.body.reply_markup)).toContain(`tp:unar:${thread}`)
  })

  test('reopening the topic in Telegram restores it and launches a session; the session then gets queued messages', async () => {
    const dir = '/tmp/arch'
    const thread = d.store.topicForProject(group, dir)!.thread_id
    const n = launched.length
    tg.push({
      message: {
        message_id: 9901, date: Math.floor(Date.now() / 1000), message_thread_id: thread, is_topic_message: true,
        from: { id: 111, is_bot: false, first_name: 'Den' },
        chat: { id: Number(group), type: 'supergroup', title: 'Test Group', is_forum: true },
        forum_topic_reopened: {},
      },
    })
    await tg.waitFor('editForumTopic', c => c.body.message_thread_id === thread && c.body.name === 'arch')
    expect(d.store.topic(group, thread)?.status).toBe('active')
    expect(launched.length).toBe(n + 1)
    expect(tg.callsOf('reopenForumTopic').length).toBe(0) // already open in Telegram

    const s = new FakeClient()
    await s.connect({ cwd: dir, projectRoot: dir, claudePid: 89 })
    const resume = await s.inbound(x => x.meta.event === 'session_resume')
    expect(resume.content).toContain('ещё вопрос')
    s.close()
  })
})

describe('paired users', () => {
  test('every allowlisted user may post in the topics group; others are ignored', async () => {
    const { loadAccess, saveAccess } = await import('../src/access.ts')
    const a = loadAccess()
    a.allowFrom.push('333')
    saveAccess(a)
    const thread = d.sessions.get(sessionId)!.topic!.threadId
    tg.push(textMessage({ from: 333, chat: -100500, text: 'я второй', thread }))
    const m = await client.inbound(x => x.content.endsWith('я второй'))
    expect(m.meta.user_id).toBe('333')
    tg.push(textMessage({ from: 444, chat: -100500, text: 'я чужой', thread }))
    await Bun.sleep(300)
    expect(client.msgs.some(x => x.t === 'inbound' && (x as Inbound).content === 'я чужой')).toBe(false)
  })
})

describe('reconnects', () => {
  test('a Claude process greeted before (daemon restart) gets no second welcome card or resume', async () => {
    const pid = process.pid // alive, so it survives pruning
    const a = new FakeClient()
    await a.connect({ cwd: '/tmp/re', projectRoot: '/tmp/re', claudePid: pid })
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('🟢 Сессия подключена') && c.body.message_thread_id != null && d.store.topicForProject('-100500', '/tmp/re')?.thread_id === c.body.message_thread_id)
    a.close()
    await Bun.sleep(100)
    const before = tg.callsOf('sendMessage').filter(c => String(c.body.text).startsWith('🟢')).length
    const b = new FakeClient()
    await b.connect({ cwd: '/tmp/re', projectRoot: '/tmp/re', claudePid: pid })
    await Bun.sleep(300)
    expect(tg.callsOf('sendMessage').filter(c => String(c.body.text).startsWith('🟢')).length).toBe(before)
    expect(b.msgs.some(m => m.t === 'inbound')).toBe(false)
    b.close()
  })
})

describe('session types', () => {
  const group = '-100500'
  const usersDir = process.env.USERS_DIR!
  const calls: { dir: string; o?: Record<string, unknown> }[] = []
  let u: FakeClient

  beforeAll(() => {
    process.env.USER_SESSIONS = 'on'
    process.env.TOPIC_NO_SESSION = 'launch'
    d.launchSession = async (dir, o) => { calls.push({ dir, o }); return '7' }
  })
  afterAll(() => {
    process.env.USER_SESSIONS = 'off'
    process.env.TOPIC_NO_SESSION = 'main'
    process.env.WATCHDOG_GRACE_SEC = '3600'
  })

  test('a DM without a user session launches it in USERS_DIR/<id>; the message arrives on connect', async () => {
    tg.push(textMessage({ text: 'привет, это я' }))
    const launchMsg = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('🚀 Запускаю вашу сессию'))
    expect(JSON.stringify(launchMsg.body.reply_markup)).toContain('tx:w7')
    expect(calls.at(-1)!.dir).toBe(`${usersDir}/111`)
    expect(calls.at(-1)!.o?.name).toBe('claude-den')
    u = new FakeClient()
    await u.connect({ cwd: `${usersDir}/111`, projectRoot: `${usersDir}/111`, claudePid: 1111 })
    const resume = await u.inbound(x => x.meta.event === 'session_resume')
    expect(resume.content).toContain('привет, это я')
    expect(d.store.topicForProject(group, `${usersDir}/111`)).toBeFalsy()
    tg.push(textMessage({ text: 'второе' }))
    await u.inbound(x => x.content === 'второе')
    expect(main.msgs.some(x => x.t === 'inbound' && ['привет, это я', 'второе'].includes((x as Inbound).content))).toBe(false)
  })

  test("General text goes to the author's user session, and the reply lands in General", async () => {
    tg.push(textMessage({ chat: Number(group), text: 'вопрос в общий' }))
    const m = await u.inbound(x => x.content === 'вопрос в общий')
    expect(m.meta.chat_id).toBe(group)
    expect(m.meta.thread_id).toBeUndefined()
    const r = await u.call('reply', { text: 'ответ в general' })
    expect(r.ok).toBe(true)
    const sent = await tg.waitFor('sendMessage', c => c.body.text === 'ответ в general')
    expect(String(sent.body.chat_id)).toBe(group)
    expect(sent.body.message_thread_id).toBeUndefined()
  })

  test('another user gets their own session; the owner is asked to confirm the launch', async () => {
    tg.push(textMessage({ from: 333, text: 'я второй пользователь' }))
    await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '333' && String(c.body.text).startsWith('🚀 Запускаю вашу сессию'))
    await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '111' && String(c.body.text).includes('(333)'))
    expect(calls.at(-1)!.dir).toBe(`${usersDir}/333`)
    expect(u.msgs.some(x => x.t === 'inbound' && (x as Inbound).content === 'я второй пользователь')).toBe(false)
  })

  test('permission requests of a user session go only to that user', async () => {
    u.sock.write(encode({ t: 'perm_req', request_id: 'uvwxy', tool_name: 'Write', description: 'write', input_preview: '{}' }))
    await tg.waitFor('sendMessage', c => c.body.text === '🔐 111: Write' && String(c.body.chat_id) === '111')
    await Bun.sleep(200)
    expect(tg.callsOf('sendMessage').some(c => c.body.text === '🔐 111: Write' && String(c.body.chat_id) === '333')).toBe(false)
  })

  test('a project topic without a session launches it; a failed launch closes the topic until the session connects', async () => {
    const { mkdirSync } = await import('fs')
    mkdirSync('/tmp/other', { recursive: true })
    const thread = d.store.topicForProject(group, '/tmp/other')!.thread_id
    d.launching.clear()
    tg.push(textMessage({ chat: Number(group), text: 'запустись', thread }))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('🚀 Запускаю сессию проекта') && c.body.message_thread_id === thread)
    expect(calls.at(-1)).toEqual({ dir: '/tmp/other', o: { name: 'claude-topic-other' } })

    d.launching.clear()
    const ok = d.launchSession
    d.launchSession = async () => { throw new Error('no tmux') }
    tg.push(textMessage({ chat: Number(group), text: 'ещё раз', thread }))
    const failed = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('❌ Не удалось запустить сессию проекта') && c.body.message_thread_id === thread)
    expect(String(failed.body.text)).toContain(`cd /tmp/other &amp;&amp; ${settings.launchCmd} -n claude-topic-other</pre>`)
    await tg.waitFor('closeForumTopic', c => c.body.message_thread_id === thread)
    expect(d.store.topic(group, thread)?.status).toBe('waiting')
    tg.push(textMessage({ chat: Number(group), text: 'и ещё', thread }))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('⏳ Сессия проекта не подключена'))
    d.launchSession = ok

    const p = new FakeClient()
    await p.connect({ cwd: '/tmp/other', projectRoot: '/tmp/other', claudePid: 2222 })
    const resume = await p.inbound(x => x.meta.event === 'session_resume')
    expect(resume.content).toContain('запустись')
    expect(resume.content).toContain('и ещё')
    await tg.waitFor('reopenForumTopic', c => c.body.message_thread_id === thread)
    expect(d.store.topic(group, thread)?.status).toBe('active')

    // Watchdog: the session goes away on its own → notice with commands, topic closed, 🚀 restarts it.
    process.env.WATCHDOG_GRACE_SEC = '0'
    const closes = tg.callsOf('closeForumTopic').length
    p.close()
    const notice = await tg.waitFor('sendMessage', c => String(c.body.text).includes('остановилась') && c.body.message_thread_id === thread)
    expect(String(notice.body.text)).toContain(`${settings.launchCmd} -n claude-topic-other --continue`)
    await tg.waitFor('closeForumTopic', () => tg.callsOf('closeForumTopic').length > closes)
    expect(d.store.topic(group, thread)?.status).toBe('waiting')
    const id = /wd:run:([0-9a-f]+)/.exec(JSON.stringify(notice.body.reply_markup))![1]
    tg.push(callbackQuery(`wd:run:${id}`, { chat: Number(group) }))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('🚀 Запускаю'))
    expect(calls.at(-1)).toEqual({ dir: '/tmp/other', o: { resume: undefined, continue: true, name: 'claude-topic-other' } })
  })

  test('a stopped user session is reported in its DM; a planned end is not', async () => {
    u.close()
    await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '111' && String(c.body.text).includes('👤') && String(c.body.text).includes('остановилась'))
    const v = new FakeClient()
    await v.connect({ cwd: `${usersDir}/111`, projectRoot: `${usersDir}/111`, claudePid: 3333 })
    const s = [...d.sessions.values()].find(x => x.claudePid === 3333)!
    d.ending.add(s.id)
    const before = tg.callsOf('sendMessage').filter(c => String(c.body.text).includes('остановилась')).length
    v.close()
    await Bun.sleep(300)
    expect(tg.callsOf('sendMessage').filter(c => String(c.body.text).includes('остановилась')).length).toBe(before)
  })
})
