/**
 * End-to-end: real daemon (in-process) + fake Bot API + a fake session client
 * over the unix socket. No real Telegram traffic.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
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
      expect(text).toContain('5 часов: <b>42%</b> ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱')
      expect(text).toContain('Неделя: <b>7%</b>')
      expect(text).toContain('через 3 д')
      expect(text).toContain('За неделю: Claude Code 90%, Chats 10%')
      // opus: 2 × (1000·4 + 1000·20 + 1M·0.2)/1M = $0.448; haiku: (1000·0.5 + 1000·2.5 + 1M·0.05)/1M = $0.053
      expect(text).toContain('opus-5-5: 2.0 млн ток. · $0.45')
      expect(text).toContain('haiku-5-5: 1.0 млн ток. · $0.05')
      expect(text).toContain('📂 proj: 3.0 млн ток. · $0.50')
      expect(text).not.toContain('📂 sub')
      expect(text).toContain('🗂 <b>По сессиям</b>, 7 дней')

      // The period of the sections: buttons, remembered; a day shows shares of spending.
      const { usageReport } = await import('../src/daemon/usage.ts')
      d.store.set('usage_period', 'd')
      const day = await usageReport(d)
      expect(day).toContain('🧠 <b>По моделям</b>, сутки')
      expect(day).toContain('👥 <b>Кто тратит</b>, сутки')
      expect(day).toMatch(/📂 проекты и главная: 100% расхода · \$0\.50/)
      d.store.set('usage_period', null)
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
        '⚠️ Лимит «5 часов»: <b>85%</b> ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱',
        '🚨 Лимит «5 часов»: <b>96%</b> ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱',
        '✅ Лимит «5 часов» восстановился: 4% ▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱',
      ])
      expect(renderDashboard(d)).toContain('📊 5 часов 3%')

      // On the minute: a window over a threshold gets a "tokens are back" at its reset (here: already due).
      const { scheduleResetNotice, usageKeyboard } = await import('../src/daemon/usage.ts')
      scheduleResetNotice(d, 'Тест', new Date(Date.now() - 29_900))
      await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('✅ Токены обновились: лимит «Тест» сброшен'))
      expect(JSON.parse(d.store.get('limit:Тест')!)).toMatchObject({ level: 0, notified: true })

      // /usage offers 🔔 per limit; pressing it remembers the request.
      const kb = JSON.stringify(usageKeyboard(d))
      expect(kb).toContain('"• 5 часов: выкл"')
      expect(kb).toContain('us:p:h5')
      tg.push(callbackQuery('lr:0'))
      await tg.waitFor('answerCallbackQuery', c => String(c.body.text).startsWith('🔔 Напомню'))
      expect(d.store.get('limit_notify:5 часов')).toBeTruthy()
      expect(JSON.stringify(usageKeyboard(d))).toMatch(/"5 часов: выкл".*"• 🔔"/)
      // 🔕: the same reminder, delivered without sound.
      tg.push(callbackQuery('lr:0:s'))
      await tg.waitFor('answerCallbackQuery', c => String(c.body.text).startsWith('🔕 Тихо напомню'))
      expect(d.store.get('limit_notify:5 часов')).toEndWith('|silent')
      expect(JSON.stringify(usageKeyboard(d))).toMatch(/"🔔".*"• 🔕"/)
      // выкл: no notice for this window, even if a threshold scheduled one.
      tg.push(callbackQuery('lr:0:x'))
      await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Без напоминания о сбросе')
      expect(d.store.get('limit_notify:5 часов')).toEndWith('|off')
      expect(JSON.stringify(usageKeyboard(d))).toContain('"• 5 часов: выкл"')
      const { requestResetNotice: req0 } = await import('../src/daemon/usage.ts')
      req0(d, 'Выкл', new Date(Date.now() - 29_900), false, true)
      await Bun.sleep(300)
      expect(tg.calls.some(c => c.method === 'sendMessage' && String(c.body.text).includes('«Выкл»'))).toBe(false)
      const { requestResetNotice } = await import('../src/daemon/usage.ts')
      requestResetNotice(d, 'Тихий', new Date(Date.now() - 29_900), true)
      const quiet = await tg.waitFor('sendMessage', c => String(c.body.text).includes('лимит «Тихий» сброшен'))
      expect(quiet.body.disable_notification).toBe(true)
      tg.push(callbackQuery('lr:0', { from: 222 }))
      await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Только для владельца подписки.')
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

  test('FR-1: the answer streams as it is written and reply(use_last_message) sends it; narration before tools is not the answer', async () => {
    const thread = d.sessions.get(sessionId)!.topic!.threadId
    const hook = (event: string, data: Record<string, unknown>) => fetch(`http://127.0.0.1:${settings.httpPort}/hook`, {
      method: 'POST', headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event, claudePid: 424242, data }),
    })
    await hook('Stop', {})
    tg.push(textMessage({ chat: Number(group), text: 'расскажи итог', thread }))
    const m = await client.inbound(x => x.content === 'расскажи итог')
    expect(m.meta.stream_answer).toBe('true')
    await hook('MessageDisplay', { delta: 'Сейчас посмотрю файлы.' })
    await hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x/a.ts' } })
    await hook('MessageDisplay', { delta: 'Итог: всё ' })
    await hook('MessageDisplay', { delta: 'готово.' })
    await tg.waitFor('editMessageText', c => String(c.body.text).includes('Итог: всё') && String(c.body.text).includes('готово.') && !String(c.body.text).includes('Сейчас посмотрю'))
    const r = await client.call('reply', { chat_id: group, use_last_message: true })
    expect(r.ok).toBe(true)
    const sent = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('Итог: всё'))
    expect(String(sent.body.text)).toBe('Итог: всё \nготово.')
    expect(String(sent.body.text)).not.toContain('Сейчас посмотрю')
    // Nothing written since the last tool: a clear error instead of an empty message.
    await hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x/b.ts' } })
    const empty = await client.call('reply', { chat_id: group, use_last_message: true })
    expect(empty.ok).toBe(false)
    expect(empty.text).toContain('use_last_message')
    // Switched off in the chat settings: no stream_answer.
    setPref(`${group}:${thread}`, { streamAnswer: false })
    tg.push(textMessage({ chat: Number(group), text: 'целиком', thread }))
    expect((await client.inbound(x => x.content === 'целиком')).meta.stream_answer).toBeUndefined()
    setPref(`${group}:${thread}`, { streamAnswer: true })
    await client.call('reply', { chat_id: group, text: 'ок' })
  })

  test('out of tokens: the failed turn and new messages get a localized notice, are held, and reach the session at the reset', async () => {
    const thread = d.sessions.get(sessionId)!.topic!.threadId
    const hook = (event: string, data: Record<string, unknown>) => fetch(`http://127.0.0.1:${settings.httpPort}/hook`, {
      method: 'POST', headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event, claudePid: 424242, data }),
    })
    const { classify, parseReset, pauseOf, release } = await import('../src/daemon/outoftokens.ts')
    expect(classify('rate_limit', "You've hit your limit · resets 2:20pm (Europe/Moscow)")).toBe('subscription')
    expect(classify('rate_limit', 'API Error: 429 {"type":"rate_limit_error"}')).toBe('rate')
    expect(classify('billing_error', 'Credit balance is too low')).toBe('billing')
    expect(classify('server_error', 'API Error: 500')).toBeNull()
    expect(new Date(parseReset('resets 2:20pm', new Date(2026, 9, 29, 9, 0).getTime())!).getHours()).toBe(14)
    // Claude Code's real text: the clock of the named zone (Moscow is UTC+3).
    expect(classify('rate_limit', "You've hit your 5-hour limit · resets 2:20pm (Europe/Moscow)")).toBe('subscription')
    expect(new Date(parseReset("You've hit your 5-hour limit · resets 2:20pm (Europe/Moscow)", Date.UTC(2026, 9, 29, 9, 50))!).toISOString()).toBe('2026-10-29T11:20:00.000Z')
    await hook('Stop', {})
    tg.push(textMessage({ chat: Number(group), text: 'сделай отчёт', thread }))
    await client.inbound(x => x.content === 'сделай отчёт')
    await hook('StopFailure', { error: 'rate_limit', last_assistant_message: 'Claude AI usage limit reached|' + Math.floor(Date.now() / 1000 + 3600) })
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('⏸ Закончились токены подписки Claude. Ход прервался'))
    expect(pauseOf(d)?.kind).toBe('subscription')
    tg.push(textMessage({ chat: Number(group), text: 'и ещё вот это', thread }))
    await tg.waitFor('sendMessage', c => String(c.body.text).includes('Сообщение записал. Отвечу сразу после сброса лимита в'))
    await release(d)
    const m = await client.inbound(x => x.content.includes('и ещё вот это'))
    expect(m.content).toContain('Пока токенов не было')
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('▶️ Лимит восстановился'))
    expect(pauseOf(d)).toBeNull()
    await client.call('reply', { chat_id: group, text: 'ок' })
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
    const dir = `${process.env.PROJECTS_DIR}/100500-77`
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

describe('invite', () => {
  test('the owner picks a contact, confirms; the user is allowlisted, their session starts, an invitation is ready', async () => {
    const { loadAccess, saveAccess } = await import('../src/access.ts')
    const launches: string[] = []
    const ok = d.launchSession
    d.launchSession = async (dir, o) => { launches.push(`${dir} ${o?.name}`); return '9' }
    process.env.USER_SESSIONS = 'on'
    try {
      tg.push(textMessage({ text: '/invite' }))
      const ask = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('Кого пригласить?'))
      const req = (ask.body.reply_markup as { keyboard: { request_users?: { request_id: number } }[][] }).keyboard[0][0].request_users!
      expect(req).toMatchObject({ user_is_bot: false, max_quantity: 1, request_username: true })

      tg.push({ message: { message_id: 90001, date: Math.floor(Date.now() / 1000), from: { id: 111, is_bot: false, first_name: 'Den' }, chat: { id: 111, type: 'private', first_name: 'Den' },
        users_shared: { request_id: req.request_id, users: [{ user_id: 555, first_name: 'Ann', username: 'ann' }] } } })
      const confirm = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('👥 Пригласить <b>Ann</b>?'))
      expect(String(confirm.body.text)).toContain('полный доступ')
      expect(loadAccess().allowFrom).not.toContain('555')

      tg.push(callbackQuery('inv:ok:555'))
      await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('✅ Ann добавлен'))
      expect(loadAccess().allowFrom).toContain('555')
      expect(launches).toEqual([`${process.env.USERS_DIR}/555 claude-555`])
      const inv = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('Привет! Я дал тебе доступ'))
      expect(String(inv.body.text)).toContain('https://t.me/testbot?start=hello')
      expect(String(inv.body.text)).toContain('https://t.me/+fakeInvite')
      expect(tg.callsOf('createChatInviteLink').at(-1)!.body.member_limit).toBe(1)

      // Only the first allowlisted user invites; a stale confirmation does nothing.
      const before = tg.callsOf('sendMessage').length
      tg.push(textMessage({ from: 555, text: '/invite' }))
      tg.push(callbackQuery('inv:ok:555'))
      await tg.waitFor('answerCallbackQuery', () => true)
      await Bun.sleep(200)
      expect(tg.callsOf('sendMessage').filter((c, i) => i >= before && String(c.body.text).startsWith('Кого пригласить')).length).toBe(0)
    } finally {
      d.launchSession = ok
      process.env.USER_SESSIONS = 'off'
      const a = loadAccess()
      a.allowFrom = a.allowFrom.filter(x => x !== '555')
      saveAccess(a)
    }
  })
})

describe('allowlist watcher', () => {
  test('a user added outside the bot (access skill) gets a folder, a session and an invitation for the owner, once', async () => {
    const { loadAccess, saveAccess } = await import('../src/access.ts')
    const { newUsers, onUserAdded } = await import('../src/daemon/invite.ts')
    const launches: string[] = []
    const ok = d.launchSession
    d.launchSession = async (dir, o) => { launches.push(`${dir} ${o?.name}`); return '4' }
    process.env.USER_SESSIONS = 'on'
    try {
      newUsers(d) // baseline
      const a = loadAccess()
      a.allowFrom.push('777')
      saveAccess(a)
      expect(newUsers(d)).toEqual(['777'])
      expect(newUsers(d)).toEqual([])
      await onUserAdded(d, '777')
      expect(launches).toEqual([`${process.env.USERS_DIR}/777 claude-777`])
      const note = tg.callsOf('sendMessage').find(c => String(c.body.text).startsWith('👥 <b>777</b> в списке доступа'))!
      expect(String(note.body.chat_id)).toBe('111')
      expect(JSON.stringify(note.body.reply_markup)).toContain('tx:w4')
      expect(String(note.body.text)).toContain('<code>/telegram-bewitched:access remove 777</code>')
      expect(tg.callsOf('sendMessage').some(c => String(c.body.text).startsWith('Привет! Я дал тебе доступ'))).toBe(true)
    } finally {
      d.launchSession = ok
      process.env.USER_SESSIONS = 'off'
      const a = loadAccess()
      a.allowFrom = a.allowFrom.filter(x => x !== '777')
      saveAccess(a)
    }
  })
})

describe('remove user', () => {
  test('from the session card: confirmation lists what goes; then access, session window, folder, transcripts and DM data are gone', async () => {
    const { loadAccess, saveAccess } = await import('../src/access.ts')
    const { projectTranscriptDir } = await import('../src/daemon/transcript.ts')
    const { addReminder, listReminders } = await import('../src/daemon/reminders.ts')
    const { userPendingKey } = await import('../src/daemon/daemon.ts')
    const dir = `${process.env.USERS_DIR}/888`
    const tr = projectTranscriptDir(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), 'x'.repeat(2000))
    mkdirSync(tr, { recursive: true })
    writeFileSync(join(tr, 's.jsonl'), '{}')
    const a = loadAccess()
    a.allowFrom.push('888')
    saveAccess(a)
    d.store.addMessage({ chat_id: '888', thread_id: null, message_id: 1, direction: 'in', from_id: '888', from_name: 'bob', date: 1, text: 'hi', kind: 'text', file_id: null, reply_to: null, quote: null, forward: null })
    d.store.addPending(userPendingKey('888'), 'queued', {})
    addReminder(d, { chatId: '888', text: 'r', at: Date.now() + 3600_000, daily: false, userId: '888' })
    // A stand-in for Claude Code: on SIGTERM it writes its last transcript lines, then exits.
    const claude = Bun.spawn(['bun', '-e', `const fs = require('fs'); process.on('SIGTERM', () => setTimeout(() => { fs.mkdirSync(${JSON.stringify(tr)}, { recursive: true }); fs.writeFileSync(${JSON.stringify(tr)} + '/last.jsonl', '{}'); process.exit(0) }, 300)); setInterval(() => {}, 1000)`])
    await Bun.sleep(300)
    const killed: string[] = []
    d.tmuxKillWindow = async t => { killed.push(t); claude.kill('SIGTERM') }
    process.env.USER_SESSIONS = 'on'
    const c = new FakeClient()
    await c.connect({ cwd: dir, projectRoot: dir, tmuxPane: '%31', claudePid: claude.pid })
    const s = d.userSession('888')!

    tg.push(callbackQuery(`sm:s:${s.id}`))
    await tg.waitFor('editMessageText', x => String(x.body.text).includes(`#${s.id}`) && JSON.stringify(x.body.reply_markup ?? '').includes('ur:ask:888'))
    tg.push(callbackQuery('ur:ask:888'))
    const conf = await tg.waitFor('editMessageText', x => String(x.body.text).startsWith('🚫 Удалить <b>bob (888)</b>?'))
    expect(String(conf.body.text)).toContain(`папка <code>${dir}</code> (2 КБ)`)
    expect(String(conf.body.text)).toContain(`транскрипты Claude Code <code>${tr}</code>`)
    expect(String(conf.body.text)).toContain(`сессия #${s.id} и её окно tmux`)
    expect(JSON.stringify(conf.body.reply_markup)).toContain('ur:kick:888')

    tg.push(callbackQuery('ur:ok:888', { from: 222 }))
    await tg.waitFor('answerCallbackQuery', x => x.body.text === 'Удалять пользователей может только владелец.')
    expect(loadAccess().allowFrom).toContain('888')

    tg.push(callbackQuery('ur:kick:888'))
    const res = await tg.waitFor('editMessageText', x => String(x.body.text).startsWith('🚫 <b>bob (888)</b> удалён.'), 8000)
    expect(String(res.body.text)).toContain('✅ исключён из группы')
    expect(loadAccess().allowFrom).not.toContain('888')
    expect(killed).toEqual(['%31'])
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(tr)).toBe(false)
    expect(d.store.history('888', null, 10).length).toBe(0)
    expect(d.store.pendingCount(userPendingKey('888'), 1000)).toBe(0)
    expect(listReminders(d).some(r => r.chatId === '888')).toBe(false)
    expect(tg.callsOf('banChatMember').at(-1)!.body.user_id).toBe(888)
    expect(tg.callsOf('unbanChatMember').at(-1)!.body.only_if_banned).toBe(true)

    tg.push(callbackQuery('ur:ask:111'))
    await tg.waitFor('answerCallbackQuery', x => x.body.text === 'Владельца удалить нельзя.')
    c.close()
    process.env.USER_SESSIONS = 'off'
  })
})

describe('user labels', () => {
  test('full name, @username if any, and the id; kept from messages', async () => {
    d.rememberUser('901', { first: 'Ann', last: 'Lee', username: 'ann' })
    expect(d.userLabel('901')).toBe('Ann Lee (@ann, 901)')
    d.rememberUser('902', { first: 'Bo' })
    expect(d.userLabel('902')).toBe('Bo (902)')
    d.rememberUser('903', { username: 'cee' })
    expect(d.userLabel('903')).toBe('@cee (903)')
    expect(d.userLabel('904')).toBe('904')
    // A long name in a session button must not be cut inside an emoji (Telegram rejects such text).
    const { sessionsList } = await import('../src/daemon/menu.ts')
    d.rememberUser('111', { first: 'Лиза', last: 'Келина-Длиннофамильная', username: 'lizka_kuz' })
    process.env.USER_SESSIONS = 'on'
    const u = new FakeClient()
    await u.connect({ cwd: `${process.env.USERS_DIR}/111`, projectRoot: `${process.env.USERS_DIR}/111`, claudePid: 9911 })
    const list = await sessionsList(d)
    for (const row of (list.kb as unknown as { inline_keyboard: { text: string }[][] }).inline_keyboard) {
      for (const b of row) expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(b.text)).toBe(false)
    }
    u.close()
    process.env.USER_SESSIONS = 'off'
    tg.push(textMessage({ from: 111, text: 'кто я' }))
    await Bun.sleep(200)
    expect(d.userLabel('111')).toBe('Den (@den, 111)')
  })
})

describe('voice', () => {
  const hasFfmpeg = Bun.spawnSync(['ffmpeg', '-version']).exitCode === 0
  const group = '-100500'
  test.skipIf(!hasFfmpeg)('a voice message is transcribed before the session sees it; replies are voiced in mirror mode; reply_voice', async () => {
    const { mkdtempSync, readFileSync } = await import('fs')
    const { tmpdir } = await import('os')
    const dir = mkdtempSync(`${tmpdir()}/voice-`)
    // A real Opus voice note and a real WAV for the fake TTS to return.
    Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', `${dir}/in.ogg`])
    Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-ac', '1', '-ar', '24000', `${dir}/out.wav`])
    tg.files.set('voice1', readFileSync(`${dir}/in.ogg`))
    let sttForm: FormData | null = null
    let ttsBody: Record<string, unknown> | null = null
    let sttText = 'привет из голоса'
    const stt = Bun.serve({ port: 0, fetch: async req => { sttForm = await req.formData(); return Response.json({ text: sttText, language: 'ru', duration: 1 }) } })
    const tts = Bun.serve({ port: 0, fetch: async req => { ttsBody = await req.json() as Record<string, unknown>; return new Response(readFileSync(`${dir}/out.wav`)) } })
    Object.assign(process.env, {
      STT_PROVIDER: 'openai-compatible', STT_URL: `http://127.0.0.1:${stt.port}/v1/audio/transcriptions`,
      TTS_PROVIDER: 'http', TTS_URL: `http://127.0.0.1:${tts.port}/v1/audio/speech`,
    })
    try {
      const thread = d.sessions.get(sessionId)!.topic!.threadId
      tg.push({ message: { message_id: 91001, date: Math.floor(Date.now() / 1000), from: { id: 111, is_bot: false, first_name: 'Den' },
        chat: { id: Number(group), type: 'supergroup', title: 'Test Group', is_forum: true }, message_thread_id: thread, is_topic_message: true,
        voice: { file_id: 'voice1', file_unique_id: 'v1', duration: 1, mime_type: 'audio/ogg' } } })
      const m = await client.inbound(x => x.content.includes('привет из голоса'))
      expect(m.content).toBe('🎤 привет из голоса')
      expect(m.meta).toMatchObject({ voice_transcribed: 'true', voice_language: 'ru', voice_duration: '1', attachment_kind: 'voice', attachment_file_id: 'voice1' })
      const file = sttForm!.get('file') as File
      expect(new TextDecoder().decode((await file.arrayBuffer()).slice(0, 4))).toBe('RIFF') // converted to WAV by ffmpeg
      expect(d.store.getMessage(group, 91001)?.text).toBe('🎤 привет из голоса')

      // mirror (the default): the answer to a spoken message is voiced, with the text as caption.
      const r = await client.call('reply', { text: 'Ответ **голосом**, подробности в `коде`' })
      expect(r.ok).toBe(true)
      const v = await tg.waitFor('sendVoice', c => String(c.body.chat_id) === group)
      expect(v.body.caption).toBe('Ответ **голосом**, подробности в `коде`')
      expect(Number(v.body.duration)).toBe(2)
      expect(ttsBody!.input).toBe('Ответ голосом, подробности в коде')
      // Same text again comes from the cache: no second synthesis.
      ttsBody = null
      await client.call('reply_voice', { text: 'Ответ **голосом**, подробности в `коде`' })
      await tg.waitFor('sendVoice', () => tg.callsOf('sendVoice').length >= 2)
      expect(ttsBody).toBeNull()

      // A text message: back to text answers.
      tg.push(textMessage({ chat: Number(group), thread, text: 'а теперь текстом' }))
      await client.inbound(x => x.content === 'а теперь текстом')
      const voices = tg.callsOf('sendVoice').length
      await client.call('reply', { text: 'текстовый ответ' })
      await tg.waitFor('sendMessage', c => c.body.text === 'текстовый ответ')
      expect(tg.callsOf('sendVoice').length).toBe(voices)

      // Nothing said: the sender hears it, the session doesn't.
      sttText = '  '
      tg.files.set('voice3', readFileSync(`${dir}/in.ogg`))
      const before = client.msgs.length
      tg.push({ message: { message_id: 91003, date: Math.floor(Date.now() / 1000), from: { id: 111, is_bot: false, first_name: 'Den' },
        chat: { id: Number(group), type: 'supergroup', title: 'Test Group', is_forum: true }, message_thread_id: thread, is_topic_message: true,
        voice: { file_id: 'voice3', file_unique_id: 'v3', duration: 1, mime_type: 'audio/ogg' } } })
      await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('🎤 В записи нет речи'), 8000)
      await Bun.sleep(200)
      expect(client.msgs.slice(before).some(x => x.t === 'inbound' && (x as Inbound).meta.attachment_file_id === 'voice3')).toBe(false)

      // STT down: the message still arrives, as before, with stt_error.
      stt.stop(true)
      tg.files.set('voice2', readFileSync(`${dir}/in.ogg`))
      tg.push({ message: { message_id: 91002, date: Math.floor(Date.now() / 1000), from: { id: 111, is_bot: false, first_name: 'Den' },
        chat: { id: Number(group), type: 'supergroup', title: 'Test Group', is_forum: true }, message_thread_id: thread, is_topic_message: true,
        voice: { file_id: 'voice2', file_unique_id: 'v2', duration: 1, mime_type: 'audio/ogg' } } })
      const failed = await client.inbound(x => x.meta.attachment_file_id === 'voice2')
      expect(failed.content).toBe('(voice message)')
      expect(failed.meta.stt_error).toBeTruthy()
    } finally {
      stt.stop(true)
      tts.stop(true)
      for (const k of ['STT_PROVIDER', 'STT_URL', 'TTS_PROVIDER', 'TTS_URL']) delete process.env[k]
    }
  }, 20_000)
})

describe('server stats', () => {
  test('/server: CPU, memory, disks, sessions; 🔄 refreshes; owner only', async () => {
    tg.push(textMessage({ text: '/server' }))
    const r = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('🖥 <b>'), 6000)
    const text = String(r.body.text)
    for (const part of ['⚙️ CPU: <b>', '🧠 Память: <b>', '💾 Диск /: <b>', '🤖 Claude Code:', '🔥 <b>Больше всего CPU</b>', '🐘 <b>Больше всего памяти</b>']) expect(text).toContain(part)
    expect(JSON.stringify(r.body.reply_markup)).toContain('srv:refresh')
    tg.push(callbackQuery('srv:refresh'))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('🖥 <b>'), 6000)
    const before = tg.callsOf('sendMessage').length
    tg.push(textMessage({ from: 333, text: '/server' }))
    await Bun.sleep(1500)
    expect(tg.callsOf('sendMessage').slice(before).some(c => String(c.body.text).startsWith('🖥'))).toBe(false)
  }, 15_000)
})

describe('menu', () => {
  test('/menu leads to every section and back; chat settings are toggled with buttons', async () => {
    const { prefsFor } = await import('../src/access.ts')
    tg.push(textMessage({ text: '/menu' }))
    const m = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('🎛 <b>Меню</b>'))
    const kb = JSON.stringify(m.body.reply_markup)
    for (const cb of ['sm:list', 'tm:list', 'hub:stats', 'hub:people', 'hub:rem', 'hub:set', 'hub:help']) expect(kb).toContain(cb)

    const open = async (data: string, startsWith: string) => {
      tg.push(callbackQuery(data))
      return tg.waitFor('editMessageText', c => String(c.body.text).startsWith(startsWith), 6000)
    }
    expect(JSON.stringify((await open('hub:stats', '📊 <b>Статистика</b>')).body.reply_markup)).toContain('srv:refresh')
    expect(JSON.stringify((await open('hub:people', '👥 <b>Люди</b>')).body.reply_markup)).toContain('inv:start')
    await open('hub:rem', '⏰ <b>Напоминания</b>')
    await open('hub:help', '❓ <b>Помощь</b>')
    const list = await open('sm:list', '📋 <b>Сессии</b>')
    expect(JSON.stringify(list.body.reply_markup)).toContain('hub:main')
    await open('hub:main', '🎛 <b>Меню</b>')

    const set = await open('hub:set', '⚙️ <b>Настройки в этой личке</b>')
    expect(JSON.stringify(set.body.reply_markup)).toContain('hub:vo:always')
    tg.push(callbackQuery('hub:v:2'))
    await tg.waitFor('editMessageText', c => String(c.body.text).includes('Подробность прогресса: 📢2'))
    expect(prefsFor('111').verbose).toBe(2)
    tg.push(callbackQuery('hub:vo:off'))
    await tg.waitFor('editMessageText', c => String(c.body.text).includes('Ответы: текстом'))
    expect(prefsFor('111').voice).toBe('off')
    tg.push(callbackQuery('hub:v:1'))
    tg.push(callbackQuery('hub:vo:mirror'))
    await tg.waitFor('editMessageText', c => String(c.body.text).includes('Ответы: голосом на голосовое'))

    tg.push(callbackQuery('hub:stats', { from: 444 }))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Нет доступа.')
    expect(tg.callsOf('setMyCommands').at(-1)?.body.commands).toBeTruthy()
  }, 20_000)
})

describe('convenience', () => {
  const group = '-100500'

  test('✅ confirm launch: folder trust, then channels, until the session connects; only those questions; ▶️ live; ✖️ close', async () => {
    const { confirmLaunch, confirmKey } = await import('../src/daemon/screen.ts')
    process.env.CONFIRM_POLL_MS = '20'
    const trust = (focus: 'yes' | 'no') => `Accessing workspace:\n/root/user/777\n\n${focus === 'no' ? '❯' : ' '} No, exit\n${focus === 'yes' ? '❯' : ' '} Yes, I trust this folder\n`
    const channels = 'WARNING: Loading development channels\n\n❯ 1. I am using this for local development\n  2. Exit\n'
    let screen: string | null = trust('no')
    const pressed: string[] = []
    let client: FakeClient | null = null
    d.tmuxCapture = async () => screen
    d.tmuxPaneId = async () => '%15'
    d.tmuxKeys = async (t, k) => {
      pressed.push(`${t} ${k.join(' ')}`)
      if (screen?.includes('Accessing workspace')) screen = k[0] === 'Down' ? trust('yes') : k[0] === 'Enter' ? channels : screen
      else if (screen?.includes('development channels') && k[0] === 'Enter') {
        screen = '╭ Claude Code\n> '
        client = new FakeClient()
        await client.connect({ cwd: '/tmp/confirm', projectRoot: '/tmp/confirm', tmuxPane: '%15', claudePid: 1515 })
      }
    }
    try {
      const r = await confirmLaunch(d, 'claude:5')
      expect(r.result).toBe('connected')
      expect(pressed).toEqual(['claude:5 Down', 'claude:5 Enter', 'claude:5 Enter'])
      // Anything else is left alone: an unknown question, or no question at all.
      expect(confirmKey('Do you want to delete everything?\n❯ Yes\n  No')).toBeNull()
      screen = '╭ Claude Code\n> '
      d.tmuxPaneId = async () => '%16'
      expect((await confirmLaunch(d, 'claude:6')).result).toBe('no_prompt')
      d.tmuxPaneId = async () => '%15'
      expect(pressed.length).toBe(3)
      client!.close()
      await Bun.sleep(100)

      // The button: answers, then replaces the screen with "connected".
      client = null
      screen = channels
      tg.push(callbackQuery('tx:w5'))
      const v = await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('🖥 <b>Экран</b> <code>claude:5</code>') && JSON.stringify(c.body.reply_markup).includes('tx:w5:c'))
      expect(JSON.stringify(v.body.reply_markup)).toContain('tx:w5:z')
      tg.push(callbackQuery('tx:w5:c', { messageId: 91 }))
      await tg.waitFor('answerCallbackQuery', c => c.body.text === '✅ Подтверждаю запуск…')
      await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('✅ Сессия #') && String(c.body.text).includes('подключилась'), 5000)
      tg.push(callbackQuery('tx:w5:c', { from: 222 }))
      await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Нет доступа.')

      tg.push(callbackQuery('tx:w5:l', { messageId: 77 }))
      const live = await tg.waitFor('editMessageText', c => String(c.body.text).includes('▶️ обновляется'))
      expect(JSON.stringify(live.body.reply_markup)).toContain('tx:w5:s')
      tg.push(callbackQuery('tx:w5:s', { messageId: 77 }))
      await tg.waitFor('answerCallbackQuery', c => c.body.text === '⏸ Остановлено')
      tg.push(callbackQuery('tx:w5:z', { messageId: 77 }))
      await tg.waitFor('deleteMessage', c => c.body.message_id === 77)
    } finally {
      ;(client as FakeClient | null)?.close()
      delete process.env.CONFIRM_POLL_MS
    }
  })

  test('⏳ a launch nobody confirmed: the owner is reminded with «✅ Подтвердить запуск», the user hears once', async () => {
    const { remindLaunch } = await import('../src/daemon/launch.ts')
    const dir = join(settings.usersDir, '555')
    d.tmuxCapture = async t => (t === 'claude:9' ? 'WARNING: Loading development channels\n❯ 1. I am using this for local development\n  2. Exit' : null)
    await remindLaunch(d, dir, '9', true)
    const owner = await tg.waitFor('sendMessage', c => c.body.chat_id === '111' && String(c.body.text).includes('(окно 9) ждёт подтверждения запуска'))
    expect(JSON.stringify(owner.body.reply_markup)).toContain('tx:w9:c')
    await tg.waitFor('sendMessage', c => c.body.chat_id === '555' && String(c.body.text).startsWith('⏳ Вашу сессию ещё подтверждают'))
    // The second reminder goes to the owner only; a gone window is not reported.
    const before = tg.callsOf('sendMessage').length
    await remindLaunch(d, dir, '9', false)
    expect(tg.callsOf('sendMessage').slice(before).map(c => c.body.chat_id)).toEqual(['111'])
    await remindLaunch(d, dir, '8', true)
    expect(tg.callsOf('sendMessage').length).toBe(before + 1)
  })

  test('📜 daemon log and ♻️ restart after a confirmation; the new daemon edits the message', async () => {
    const { setRestartDaemon, reportRestart } = await import('../src/daemon/server.ts')
    let restarts = 0
    setRestartDaemon(() => { restarts++ })
    tg.push(callbackQuery('srv:logs'))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('📜 <b>Лог демона</b>'))
    tg.push(callbackQuery('srv:rs'))
    const ask = await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('♻️ Перезапустить демон'))
    expect(JSON.stringify(ask.body.reply_markup)).toContain('srv:rsok')
    expect(restarts).toBe(0)
    tg.push(callbackQuery('srv:rsok', { messageId: 55 }))
    await tg.waitFor('editMessageText', c => c.body.text === '♻️ Перезапускаю демон…')
    expect(restarts).toBe(1)
    expect(JSON.parse(d.store.get('restart_notice')!)).toMatchObject({ messageId: 55 })
    await reportRestart(d, 0)
    const done = await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('✅ Демон перезапущен'))
    expect(done.body.message_id).toBe(55)
    expect(d.store.get('restart_notice')).toBeNull()
    tg.push(callbackQuery('srv:rs', { from: 222 }))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Только для владельца.')
  })

  test('🕘 past conversations: listed with their first words; /resume <id> typed into the pane', async () => {
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-hist')
    mkdirSync(dir, { recursive: true })
    const a = '11111111-aaaa-4aaa-8aaa-111111111111', b = '22222222-bbbb-4bbb-8bbb-222222222222'
    const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
    writeFileSync(join(dir, `${a}.jsonl`), user('<channel source="x" chat_id="1">\nстарый разговор про CI\n</channel>') + '\n')
    writeFileSync(join(dir, `${b}.jsonl`), user('текущий разговор') + '\n')
    const c = new FakeClient()
    await c.connect({ cwd: '/tmp/hist', projectRoot: '/tmp/hist', tmuxPane: '%21', claudePid: 2121 })
    const s = [...d.sessions.values()].find(x => x.projectKey === '/tmp/hist')!
    s.claude.sessionId = b
    const typed: string[] = []
    d.tmuxType = async (t, text) => { typed.push(`${t} ${text}`) }
    try {
      tg.push(callbackQuery(`sm:s:${s.id}`))
      const card = await tg.waitFor('editMessageText', x => String(x.body.text).includes(`#${s.id}`) && JSON.stringify(x.body.reply_markup).includes('sm:hist'))
      expect(JSON.stringify(card.body.reply_markup)).toContain(`mc:list:${s.id}`)
      tg.push(callbackQuery(`sm:hist:${s.id}`))
      const h = await tg.waitFor('editMessageText', x => String(x.body.text).startsWith('🕘 <b>Разговоры</b>'))
      expect(String(h.body.text)).toContain('старый разговор про CI')
      expect(String(h.body.text)).toContain('<b>сейчас</b>')
      const kb = JSON.stringify(h.body.reply_markup)
      expect(kb).toContain(`sm:rs:${s.id}:${a.replace(/-/g, '')}`)
      expect(kb).not.toContain(b.replace(/-/g, ''))
      tg.push(callbackQuery(`sm:rs:${s.id}:${a.replace(/-/g, '')}`))
      await tg.waitFor('editMessageText', x => String(x.body.text).startsWith('Продолжить разговор от'))
      expect(typed).toEqual([])
      tg.push(callbackQuery(`sm:rsok:${s.id}:${a.replace(/-/g, '')}`))
      await tg.waitFor('answerCallbackQuery', x => x.body.text === `➡️ /resume ${a}`)
      expect(typed).toEqual([`%21 /resume ${a}`])
    } finally {
      c.close()
    }
  })

  test('📌 always in the project: allowed without asking, shown in the card, removed with ❌', async () => {
    const asks = () => tg.callsOf('sendMessage').filter(c => c.body.text === '🔐 proj: Write').length
    client.sock.write(encode({ t: 'perm_req', request_id: 'hijkm', tool_name: 'Write', description: 'write a', input_preview: '{}' }))
    const msg = await tg.waitFor('sendMessage', c => c.body.text === '🔐 proj: Write')
    expect(JSON.stringify(msg.body.reply_markup)).toContain('perm:proj:hijkm')
    tg.push(callbackQuery('perm:proj:hijkm', { chat: Number(group) }))
    expect(await client.wait(m => m.t === 'perm' && m.request_id === 'hijkm')).toMatchObject({ behavior: 'allow' })
    const { projectRules } = await import('../src/daemon/permrules.ts')
    expect(projectRules(d, '/tmp/proj')).toEqual(['Write'])
    // A new session of the project (no ♾ memory) is not asked either.
    d.sessions.get(sessionId)!.alwaysAllow.clear()
    const before = asks()
    client.sock.write(encode({ t: 'perm_req', request_id: 'jkmno', tool_name: 'Write', description: 'write b', input_preview: '{}' }))
    expect(await client.wait(m => m.t === 'perm' && m.request_id === 'jkmno')).toMatchObject({ behavior: 'allow' })
    expect(asks()).toBe(before)
    tg.push(callbackQuery(`sm:s:${sessionId}`))
    const card = await tg.waitFor('editMessageText', c => String(c.body.text).includes('📌 без вопросов в проекте: Write'))
    expect(JSON.stringify(card.body.reply_markup)).toContain(`sm:prm:${sessionId}`)
    tg.push(callbackQuery(`sm:prmd:${sessionId}:0`))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === '🔐 Write снова спрашивается')
    expect(projectRules(d, '/tmp/proj')).toEqual([])
  })

  test('⚡ quick commands: /macro add in a topic, the button posts the text and hands it to the session', async () => {
    const thread = d.sessions.get(sessionId)!.topic!.threadId
    tg.push(textMessage({ chat: Number(group), thread, text: '/macro add 🧪 Тесты | прогони тесты' }))
    const list = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('⚡ <b>Быстрые команды</b>') && c.body.message_thread_id === thread)
    expect(String(list.body.text)).toContain('<b>🧪 Тесты</b> — прогони тесты')
    expect(JSON.stringify(list.body.reply_markup)).toContain(`mc:r:${group}:${thread}:0`)
    tg.push(callbackQuery(`mc:r:${group}:${thread}:0`, { chat: Number(group) }))
    await tg.waitFor('sendMessage', c => c.body.text === '⚡ прогони тесты' && c.body.message_thread_id === thread)
    const m = await client.inbound(x => x.content === 'прогони тесты')
    expect(m.meta).toMatchObject({ event: 'macro', macro: '🧪 Тесты' })
    tg.push(textMessage({ chat: Number(group), thread, text: '/macro del 1' }))
    await tg.waitFor('sendMessage', c => String(c.body.text).includes('Пока нет ни одной.'))
    tg.push(textMessage({ chat: Number(group), thread, text: '/macro add без разделителя' }))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('Формат: /macro add'))
  })

  test('📡 /event over HTTP: posted to the topic and handed to the session', async () => {
    const thread = d.sessions.get(sessionId)!.topic!.threadId
    const res = await fetch(`http://127.0.0.1:${settings.httpPort}/event`, {
      method: 'POST', headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'proj', source: 'ci', text: 'build failed on main' }),
    })
    expect(res.status).toBe(200)
    await tg.waitFor('sendMessage', c => c.body.text === '📡 ci: build failed on main' && c.body.message_thread_id === thread)
    const m = await client.inbound(x => x.content.includes('Внешнее событие (ci)'))
    expect(m.meta).toMatchObject({ event: 'external', source: 'ci' })
    const bad = await fetch(`http://127.0.0.1:${settings.httpPort}/event`, {
      method: 'POST', headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'nope', text: 'x' }),
    })
    expect(bad.status).toBe(400)
  })

  test('CI watch: the first look is silent, a failure gets 🛠 Починить, green after red is announced', async () => {
    const { checkCi, setLatestRun } = await import('../src/daemon/events.ts')
    let run = { databaseId: 1, status: 'completed', conclusion: 'success', name: 'tests', displayTitle: 'feat: x', url: 'https://github.com/o/r/actions/runs/1' }
    setLatestRun(async (_cwd, branch) => (branch === 'main' ? run : null))
    const notes = () => tg.callsOf('sendMessage').filter(c => String(c.body.text).includes('CI '))
    const before = notes().length
    await checkCi(d)
    expect(notes().length).toBe(before)
    run = { ...run, databaseId: 2, conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/2' }
    await checkCi(d)
    await checkCi(d)
    const fail = notes().slice(before)
    expect(fail.length).toBe(1)
    expect(String(fail[0].body.text)).toStartWith('❌ <b>CI упал</b> на <code>main</code>')
    expect(JSON.stringify(fail[0].body.reply_markup)).toContain(`ci:fix:${sessionId}`)
    tg.push(callbackQuery(`ci:fix:${sessionId}`, { chat: Number(group) }))
    const m = await client.inbound(x => x.content.startsWith('CI упал на ветке main'))
    expect(m.content).toContain('gh run view 2 --log-failed')
    run = { ...run, databaseId: 3, conclusion: 'success' }
    await checkCi(d)
    expect(String(notes().at(-1)!.body.text)).toStartWith('✅ <b>CI снова зелёный</b>')
  })

  test('👥 shares of the 5-hour window by person; 🌙 quiet hours make every send silent; voice settings', async () => {
    const { windowShares } = await import('../src/daemon/usage.ts')
    const now = Date.now()
    const e = (cwd: string, output: number) => ({ id: `${cwd}${output}`, ts: now - 60_000, model: 'claude-opus-5-5', input: 0, output, write5m: 0, write1h: 0, read: 0, cwd })
    const ws = windowShares(d, { items: [{ label: '5 часов', percent: 50, resetsAt: new Date(now + 3600_000) }], breakdown: null },
      [e(join(settings.usersDir, '222'), 3_000_000), e('/tmp/proj', 1_000_000)], now)!
    expect(ws.shares.map(s => [s.userId, Math.round(s.percent)])).toEqual([['222', 38], [null, 13]])

    d.store.set('quiet_hours', '00:00-23:59')
    await d.bot.api.sendMessage('111', 'тихо')
    expect(tg.callsOf('sendMessage').at(-1)!.body.disable_notification).toBe(true)
    d.store.set('quiet_hours', 'off')
    await d.bot.api.sendMessage('111', 'громко')
    expect(tg.callsOf('sendMessage').at(-1)!.body.disable_notification).toBeUndefined()

    process.env.TTS_PROVIDER = 'silero'
    try {
      tg.push(callbackQuery('hub:set'))
      const set = await tg.waitFor('editMessageText', c => String(c.body.text).includes('Голос: xenia'))
      const kb = JSON.stringify(set.body.reply_markup)
      for (const cb of ['hub:tv:baya', 'hub:ts:125', 'hub:qh:2']) expect(kb).toContain(cb)
      tg.push(callbackQuery('hub:tv:baya'))
      tg.push(callbackQuery('hub:ts:125'))
      await tg.waitFor('editMessageText', c => String(c.body.text).includes('Голос: baya, скорость ×1.25'))
      expect(prefsFor('111')).toMatchObject({ ttsVoice: 'baya', ttsSpeed: 1.25 })
      tg.push(callbackQuery('hub:qh:2'))
      await tg.waitFor('answerCallbackQuery', c => c.body.text === '🌙 Тихие часы: 23:00–08:00')
      expect(d.store.get('quiet_hours')).toBe('23:00-08:00')
      d.store.set('quiet_hours', null)
    } finally {
      delete process.env.TTS_PROVIDER
    }
  })
})

describe('ordinary groups as projects', () => {
  const g1 = '-200700', g2 = '-200701'
  test('an allowed group is bound from the owner DM: new project, its session answers there; «not a project» goes to main; unbind', async () => {
    const { loadAccess, saveAccess } = await import('../src/access.ts')
    const { groupBinding } = await import('../src/daemon/groups.ts')
    const a = loadAccess()
    a.groups[g1] = { requireMention: false, allowFrom: [], allowPaired: true }
    a.groups[g2] = { requireMention: false, allowFrom: [], allowPaired: true }
    saveAccess(a)
    const dir = join(settings.projectsDir, '200700')
    const launchedBefore = launched.length

    // Unbound: queued, the group hears once, the owner gets a card in DM.
    tg.push(textMessage({ chat: Number(g1), text: 'привет, проект' }))
    const card = await tg.waitFor('sendMessage', c => c.body.chat_id === '111' && String(c.body.text).startsWith('👥 Группа <b>Test Group</b>'))
    expect(JSON.stringify(card.body.reply_markup)).toContain(`gp:new:${g1}`)
    await tg.waitFor('sendMessage', c => String(c.body.chat_id) === g1 && String(c.body.text).startsWith('⏳ Владелец ещё не настроил'))
    tg.push(textMessage({ chat: Number(g1), text: 'второе' }))
    await Bun.sleep(300)
    expect(tg.callsOf('sendMessage').filter(c => c.body.chat_id === '111' && String(c.body.text).startsWith('👥 Группа')).length).toBe(1)

    // 📁 New project: bound, folder created, the session launched; the owner confirms in DM.
    tg.push(callbackQuery(`gp:new:${g1}`))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('✅ Группа <b>Test Group</b> — проект'))
    expect(groupBinding(d, g1)).toEqual({ dir, title: 'Test Group' })
    expect(existsSync(dir)).toBe(true)
    expect(launched.slice(launchedBefore)).toContain(dir)
    await tg.waitFor('sendMessage', c => String(c.body.chat_id) === g1 && String(c.body.text).startsWith('🚀 Запускаю сессию проекта'))

    // The session connects: no topic, it answers in the group, the queued messages arrive.
    const topicsBefore = tg.callsOf('createForumTopic').length
    const c = new FakeClient()
    await c.connect({ cwd: dir, projectRoot: dir, claudePid: 7007 })
    try {
      const resume = await c.inbound(m => m.meta.event === 'session_resume')
      expect(resume.content).toContain('привет, проект')
      expect(resume.content).toContain('второе')
      expect(resume.meta.chat_id).toBe(g1)
      expect(tg.callsOf('createForumTopic').length).toBe(topicsBefore)
      const s = [...d.sessions.values()].find(x => x.projectKey === dir)!
      expect(s.group).toEqual({ chatId: g1, title: 'Test Group' })
      tg.push(textMessage({ chat: Number(g1), text: 'дальше' }))
      expect((await c.inbound(m => m.content === 'дальше')).meta.chat_id).toBe(g1)
      expect((await c.call('reply', { chat_id: g1, text: 'ответ в группу' })).ok).toBe(true)
      await tg.waitFor('sendMessage', x => String(x.body.chat_id) === g1 && x.body.text === 'ответ в группу')

      // Permission requests of a group's project go to the owner only, never to the group.
      c.sock.write(encode({ t: 'perm_req', request_id: 'mnopq', tool_name: 'Bash', description: 'ls', input_preview: '{}' }))
      await tg.waitFor('sendMessage', x => x.body.chat_id === '111' && String(x.body.text).startsWith('🔐 Test Group: Bash'))
      expect(tg.callsOf('sendMessage').some(x => String(x.body.chat_id) === g1 && String(x.body.text).startsWith('🔐'))).toBe(false)

      // The card shows the group; unbinding asks first.
      tg.push(callbackQuery(`sm:s:${s.id}`))
      const sc = await tg.waitFor('editMessageText', x => String(x.body.text).includes('👥 группа «Test Group»'))
      expect(JSON.stringify(sc.body.reply_markup)).toContain(`gp:unbind:${g1}`)
      tg.push(callbackQuery('gp:list'))
      await tg.waitFor('editMessageText', x => String(x.body.text).startsWith('👥 <b>Группы</b>') && String(x.body.text).includes('200700'))
      tg.push(callbackQuery(`gp:unbind:${g1}`))
      await tg.waitFor('editMessageText', x => String(x.body.text).startsWith('Отвязать группу <b>Test Group</b>'))
      tg.push(callbackQuery(`gp:unbok:${g1}`))
      await tg.waitFor('answerCallbackQuery', x => x.body.text === '🚫 Отвязано')
      expect(groupBinding(d, g1)).toBeNull()
    } finally {
      c.close()
    }

    // 🚫 Not a project: what waited goes to the main session, and so does what comes next.
    tg.push(textMessage({ chat: Number(g2), text: 'в главную' }))
    await tg.waitFor('sendMessage', x => x.body.chat_id === '111' && String(x.body.text).includes(`<code>${g2}</code>`))
    tg.push(callbackQuery(`gp:none:${g2}`))
    await tg.waitFor('editMessageText', x => String(x.body.text).includes('не проект'))
    expect(groupBinding(d, g2)).toEqual({ dir: null, title: 'Test Group' })
  })
})

describe('several topic groups (FR-3)', () => {
  test('a second forum group is extra: projects under its folders get their topic there; messages route; /topics switches groups', async () => {
    const extra = '-100900'
    await connectGroup(d, extra, 'Work')
    expect(d.topicsChatId).toBe('-100500')
    expect(d.extraTopicGroups()).toEqual([{ chatId: extra, title: 'Work', paths: [] }])
    const work = join(settings.projectsDir, 'work')
    mkdirSync(join(work, 'api'), { recursive: true })
    const groups = d.extraTopicGroups()
    groups[0].paths = [work]
    d.setExtraTopicGroups(groups)
    expect(d.topicsChatFor(join(work, 'api'))).toBe(extra)
    expect(d.topicsChatFor('/tmp/elsewhere')).toBe('-100500')

    const c = new FakeClient()
    await c.connect({ cwd: join(work, 'api'), projectRoot: join(work, 'api'), claudePid: 9090 })
    try {
      const created = await tg.waitFor('createForumTopic', x => String(x.body.chat_id) === extra)
      expect(created.body.name).toBe('api')
      const s = [...d.sessions.values()].find(x => x.projectKey === join(work, 'api'))!
      expect(s.topic?.chatId).toBe(extra)
      tg.push(textMessage({ chat: Number(extra), thread: s.topic!.threadId, text: 'в рабочей группе' }))
      expect((await c.inbound(x => x.content === 'в рабочей группе')).meta.chat_id).toBe(extra)

      tg.push(callbackQuery('tm:list:1'))
      const list = await tg.waitFor('editMessageText', x => String(x.body.text).includes('Группа: <b>Work</b>'))
      expect(JSON.stringify(list.body.reply_markup)).toContain(`tm:t:${s.topic!.threadId}:1`)
      tg.push(callbackQuery('tm:groups'))
      await tg.waitFor('editMessageText', x => String(x.body.text).startsWith('🗂 <b>Группы топиков</b>') && String(x.body.text).includes('Work'))
      tg.push(callbackQuery('tm:goffok:1'))
      await tg.waitFor('answerCallbackQuery', x => x.body.text === '🔌 Отключена')
      expect(d.extraTopicGroups()).toEqual([])
    } finally {
      c.close()
    }
  })
})

describe('limit warmup', () => {
  test('⚡ on: a tiny request right after the 5-hour reset, once per window; limit notices refresh and delete', async () => {
    const { scheduleWarmup, setRunWarmup, warmupOn, fireWarmup } = await import('../src/daemon/usage.ts')
    let runs = 0
    setRunWarmup(async () => { runs++ })
    expect(warmupOn(d)).toBe(false)
    tg.push(callbackQuery('us:r'))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === '📊 Собираю…')
    tg.push(callbackQuery('us:w:on'))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === '⚡ Окно будет запускаться сразу после сброса')
    expect(warmupOn(d)).toBe(true)
    const at = new Date(Date.now() - 59_990)
    scheduleWarmup(d, at)
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('⚡ Новое окно «5 часов» запущено'))
    expect(runs).toBe(1)
    await fireWarmup(d, at.toISOString())
    expect(runs).toBe(1)
    tg.push(callbackQuery('la:x', { messageId: 4242 }))
    await tg.waitFor('deleteMessage', c => c.body.message_id === 4242)
    d.store.set('limit_warmup', null)
  })
})

describe('languages', () => {
  test('/lang and ⚙️ switch the chat language; /menu follows it; commands per language', async () => {
    tg.push(textMessage({ text: '/lang en' }))
    await tg.waitFor('sendMessage', c => c.body.text === 'Language: 🇬🇧 English')
    expect(prefsFor('111').lang).toBe('en')
    tg.push(textMessage({ text: '/menu' }))
    const m = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('🎛 <b>Menu</b>'))
    expect(JSON.stringify(m.body.reply_markup)).toContain('📋 Sessions')
    tg.push(callbackQuery('hub:set'))
    const set = await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('⚙️ <b>Settings in this DM</b>'))
    expect(JSON.stringify(set.body.reply_markup)).toContain('hub:lg:de')
    tg.push(callbackQuery('hub:lg:de'))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('⚙️ <b>Einstellungen in diesem Privatchat</b>'))
    tg.push(textMessage({ text: '/lang ru' }))
    await tg.waitFor('sendMessage', c => c.body.text === 'Язык: 🇷🇺 Русский')
    tg.push(textMessage({ text: '/lang auto' }))
    await tg.waitFor('sendMessage', c => c.body.text === 'Язык: как в Telegram')
    expect(prefsFor('111').lang).toBe('')
  })
})

describe('roles (FR-4)', () => {
  test('a member writes and answers but cannot approve permissions or use the panel; a viewer is ignored; the owner switches roles in /users', async () => {
    const { loadAccess, saveAccess, roleOf } = await import('../src/access.ts')
    const a = loadAccess()
    a.allowFrom.push('555', '556')
    a.roles = { '556': 'viewer' }
    saveAccess(a)
    expect(roleOf('111')).toBe('owner')
    expect(roleOf('555')).toBe('member')
    expect(roleOf('556')).toBe('viewer')
    const group = '-100500'
    const thread = d.sessions.get(sessionId)!.topic!.threadId
    // A member's message reaches the session with its role.
    tg.push(textMessage({ from: 555, chat: Number(group), thread, text: 'от участника' }))
    expect((await client.inbound(x => x.content === 'от участника')).meta.user_role).toBe('member')
    // A viewer's does not.
    tg.push(textMessage({ from: 556, chat: Number(group), thread, text: 'от наблюдателя' }))
    await Bun.sleep(400)
    expect(client.msgs.some(x => (x as Inbound).content === 'от наблюдателя')).toBe(false)
    // Permissions: only the owner is asked, a member's tap is refused.
    client.sock.write(encode({ t: 'perm_req', request_id: 'rstuv', tool_name: 'Bash', description: 'ls', input_preview: '{}' }))
    await tg.waitFor('sendMessage', c => c.body.chat_id === '111' && String(c.body.text).startsWith('🔐 proj: Bash') || String(c.body.chat_id) === group && String(c.body.text).startsWith('🔐 proj: Bash'))
    expect(tg.callsOf('sendMessage').some(c => c.body.chat_id === '555' && String(c.body.text).startsWith('🔐'))).toBe(false)
    tg.push(callbackQuery('perm:allow:rstuv', { from: 555, chat: Number(group) }))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Разрешения одобряет только владелец.')
    tg.push(callbackQuery('perm:allow:rstuv', { chat: Number(group) }))
    expect(await client.wait(m => m.t === 'perm' && m.request_id === 'rstuv')).toMatchObject({ behavior: 'allow' })
    // The panel is the owner's.
    tg.push(callbackQuery('sm:list', { from: 555 }))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Нет доступа.' && tg.callsOf('answerCallbackQuery').length > 0)
    // /users: the owner switches roles.
    tg.push(callbackQuery('ur:role:556:m'))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === '👤 Теперь участник')
    expect(roleOf('556')).toBe('member')
    const b = loadAccess()
    b.allowFrom = b.allowFrom.filter(x => x !== '555' && x !== '556')
    delete b.roles
    saveAccess(b)
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
    expect(calls.at(-1)!.o?.name).toBe('claude-111')
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
    expect(calls.at(-1)).toEqual({ dir: '/tmp/other', o: { name: 'claude-other' } })

    d.launching.clear()
    const ok = d.launchSession
    d.launchSession = async () => { throw new Error('no tmux') }
    tg.push(textMessage({ chat: Number(group), text: 'ещё раз', thread }))
    const failed = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('❌ Не удалось запустить сессию проекта') && c.body.message_thread_id === thread)
    expect(String(failed.body.text)).toContain(`cd /tmp/other &amp;&amp; ${settings.launchCmd} -n claude-other</pre>`)
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
    expect(String(notice.body.text)).toContain(`${settings.launchCmd} -n claude-other --continue`)
    await tg.waitFor('closeForumTopic', () => tg.callsOf('closeForumTopic').length > closes)
    expect(d.store.topic(group, thread)?.status).toBe('waiting')
    const id = /wd:run:([0-9a-f]+)/.exec(JSON.stringify(notice.body.reply_markup))![1]
    tg.push(callbackQuery(`wd:run:${id}`, { chat: Number(group) }))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('🚀 Запускаю'))
    expect(calls.at(-1)).toEqual({ dir: '/tmp/other', o: { resume: undefined, continue: true, name: 'claude-other' } })
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
