/**
 * End-to-end: real daemon (in-process) + fake Bot API + a fake session client
 * over the unix socket. No real Telegram traffic.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
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
    this.sock?.end()
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
// The owner's (111) own session: DMs and General go to it.
const mainDir = `${process.env.USERS_DIR!}/111`
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
  test('a DM while the owner\'s session is not running is queued, the session is launched, and the message arrives on connect', async () => {
    tg.push(textMessage({ text: 'есть кто?' }))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('🚀 Запускаю вашу сессию'))
    expect(launched).toContain(mainDir)
    await main.connect({ cwd: mainDir, projectRoot: null, claudePid: 777 })
    const resume = await main.inbound(x => x.meta.event === 'session_resume')
    expect(resume.content).toContain('есть кто?')
    expect(resume.meta.pending_count).toBe('1')
    expect(client.msgs.some(m => m.t === 'inbound')).toBe(false)
  })

  test('inbound DM reaches the owner\'s own session, not the project session, and opens a draft stream', async () => {
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
    // F08: a button answer says who tapped, like a typed message.
    expect(m.meta.user_role).toBe('owner')
    expect(m.content).toBe('Нет')
    expect(m.meta.question_id).toBe(qid)
    expect(m.meta.option_index).toBe('1')

    tg.push(callbackQuery(`q:${qid}:0`))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === 'На этот вопрос уже ответили.')
  })

  test('the chosen answer: one ✅, green; the recommendation colour goes away', async () => {
    const r = await client.call('ask_user', { chat_id: '111', text: 'Выпускаем?', options: [{ label: '✅ Выпустить', style: 'primary' }, 'Позже'] })
    const qid = /question_id: ([0-9a-f]{8})/.exec(r.text)![1]
    await tg.waitFor('sendMessage', c => c.body.text === 'Выпускаем?')
    tg.push(callbackQuery(`q:${qid}:0`))
    const e = await tg.waitFor('editMessageReplyMarkup', c => JSON.stringify(c.body.reply_markup).includes(`q:${qid}:`))
    const [chosen, other] = (e.body.reply_markup as { inline_keyboard: { text: string; style?: string }[][] }).inline_keyboard.flat()
    expect(chosen).toMatchObject({ text: '✅ Выпустить', style: 'success' })
    expect(other.style).toBeUndefined()
  })

  test('reply with buttons and copy: both kinds in one keyboard; 📋 stays after the tap', async () => {
    const r = await client.call('reply', { chat_id: '111', text: 'Слить?', buttons: ['Да', 'Нет'], copy: [{ label: '📋 Команда', text: 'gh pr merge 1' }] })
    expect(r.ok).toBe(true)
    const qid = /question_id: ([0-9a-f]{8})/.exec(r.text)![1]
    const sent = await tg.waitFor('sendMessage', c => c.body.text === 'Слить?')
    const flat = (m: unknown) => (m as { inline_keyboard: { text: string; callback_data?: string; copy_text?: { text: string } }[][] }).inline_keyboard.flat()
    expect(flat(sent.body.reply_markup).map(b => b.callback_data ?? b.copy_text?.text)).toEqual([`q:${qid}:0`, `q:${qid}:1`, 'gh pr merge 1'])
    tg.push(callbackQuery(`q:${qid}:0`))
    const e = await tg.waitFor('editMessageReplyMarkup', c => JSON.stringify(c.body.reply_markup).includes(`q:${qid}:`))
    expect(flat(e.body.reply_markup).at(-1)?.copy_text?.text).toBe('gh pr merge 1')
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

  test('a progress message left by the previous daemon (restarted mid-turn) loses ⏹ and says why on the next start', async () => {
    const { closeOrphanProgress } = await import('../src/daemon/stream.ts')
    d.store.set(`progress_msg:${group}:4242`, 'dead')
    await closeOrphanProgress(d)
    const e = await tg.waitFor('editMessageText', c => c.body.message_id === 4242)
    expect(String(e.body.text)).toStartWith('⚪️ Прогресс прервался: демон перезапускался')
    expect(e.body.reply_markup).toEqual({ inline_keyboard: [] })
    expect(d.store.get(`progress_msg:${group}:4242`)).toBeNull()
  })

  test('message in the topic routes to the session; progress message + hook lines + delete on reply', async () => {
    const thread = d.sessions.get(sessionId)!.topic!.threadId
    tg.push(textMessage({ chat: Number(group), text: 'сделай тесты', thread }))
    const m = await client.inbound(x => x.content === 'сделай тесты')
    expect(m.meta.thread_id).toBe(String(thread))
    expect(m.meta.topic_name).toBe('proj')
    const progress = await tg.waitFor('sendMessage', c => c.body.text === '⏳ Работаю… · 🔔1')
    expect(JSON.stringify(progress.body.reply_markup)).toContain(`stop:${sessionId}`)
    // Remembered while open: a daemon restart mid-turn closes it on the next start.
    for (let i = 0; i < 50 && !d.store.keys('progress_msg:').length; i++) await Bun.sleep(20)
    expect(d.store.keys('progress_msg:').some(k => k.startsWith(`progress_msg:${group}:`))).toBe(true)

    const res = await fetch(`http://127.0.0.1:${settings.httpPort}/hook`, {
      method: 'POST',
      headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'PreToolUse', claudePid: 424242, data: { tool_name: 'Bash', tool_input: { command: 'bun test', description: 'Run tests' } } }),
    })
    expect(res.status).toBe(200)
    // FR-11: the progress message is rich — the steps in a collapsible quote.
    const edit = await tg.waitFor('editMessageText', c => JSON.stringify(c.body.rich_message ?? '').includes('💻 Run tests'))
    expect(String((edit.body.rich_message as { markdown: string }).markdown)).toContain('<blockquote expandable>')

    // An edit that only lost a race (a newer edit of the same message won) keeps the progress rich, with no plain re-edit.
    const hook = (cmd: string) => fetch(`http://127.0.0.1:${settings.httpPort}/hook`, {
      method: 'POST',
      headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'PreToolUse', claudePid: 424242, data: { tool_name: 'Bash', tool_input: { command: cmd, description: cmd } } }),
    })
    const plain = () => tg.callsOf('editMessageText').filter(c => String(c.body.text ?? '').startsWith('⏳ Работаю')).length
    const before = plain()
    tg.failures.set('editMessageText', { code: 400, description: 'Bad Request: canceled by new edit message request' })
    await hook('lint')
    await Bun.sleep(settings.groupEditIntervalMs + 300)
    tg.failures.delete('editMessageText')
    expect(plain()).toBe(before)
    await hook('typecheck')
    await tg.waitFor('editMessageText', c => JSON.stringify(c.body.rich_message ?? '').includes('typecheck'), 5000)

    // The chat ends an answer by editing (the default): the progress message becomes it, no second message.
    const r = await client.call('reply', { chat_id: group, text: 'готово' })
    expect(r.ok).toBe(true)
    const ans = await tg.waitFor('editMessageText', c => c.body.text === 'готово')
    expect(ans.body.message_id).toBe(edit.body.message_id)
    expect(ans.body.reply_markup).toBeUndefined()
  })

  test('a project topic without a session queues the message (TOPIC_NO_SESSION=queue); it reaches the session on connect', async () => {
    const other = new FakeClient()
    await other.connect({ cwd: '/tmp/other', projectRoot: '/tmp/other', claudePid: 5 })
    await tg.waitFor('createForumTopic', c => c.body.name === 'other')
    other.close()
    for (let i = 0; i < 100 && d.sessionForProject('/tmp/other'); i++) await Bun.sleep(20)
    const thread = Number((d.store.topicForProject(group, '/tmp/other'))!.thread_id)
    tg.push(textMessage({ chat: Number(group), text: 'ты тут?', thread }))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('💤 Сессия этого проекта'))
    expect(main.msgs.some(x => x.t === 'inbound' && (x as Inbound).content === 'ты тут?')).toBe(false)

    const again = new FakeClient()
    await again.connect({ cwd: '/tmp/other', projectRoot: '/tmp/other', claudePid: 6 })
    const resume = await again.inbound(x => x.meta.event === 'session_resume')
    expect(resume.content).toContain('ты тут?')
    expect(resume.meta.pending_count).toBe('1')
    again.close()
  })

  test('a session writing into another session\'s topic: that session hears it (session_message), the writer does not', async () => {
    const thread = d.sessions.get(sessionId)!.topic!.threadId
    const other = new FakeClient()
    await other.connect({ cwd: '/tmp/writer', projectRoot: '/tmp/writer', claudePid: 7 })
    await tg.waitFor('createForumTopic', c => c.body.name === 'writer')
    try {
      const r = await other.call('reply', { chat_id: group, message_thread_id: String(thread), text: 'Отчёт: Codex не применяет настройки' })
      expect(r.ok).toBe(true)
      const m = await client.inbound(x => x.meta.event === 'session_message')
      expect(m.content).toBe('Отчёт: Codex не применяет настройки')
      expect(m.meta.thread_id).toBe(String(thread))
      expect(m.meta.from_session_name).toBe('writer')
      // notify by topic name (how Codex posted its review), with an attachment: heard too, the file's path included.
      const topicName = d.sessions.get(sessionId)!.topic!.name
      const f = join(mkdtempSync(join(tmpdir(), 'relay-')), 'review.md')
      writeFileSync(f, '# review')
      await other.call('notify', { topic: topicName, text: 'Ревью: 10 замечаний', files: [f] })
      const n = await client.inbound(x => x.meta.event === 'session_message' && x.content.startsWith('Ревью'))
      expect(n.content).toContain(`[attached files: ${f}]`)
      // A reply into its own topic goes nowhere else.
      const writerThread = Number(d.store.topicForProject(group, '/tmp/writer')!.thread_id)
      await other.call('reply', { chat_id: group, message_thread_id: String(writerThread), text: 'себе' })
      await Bun.sleep(50)
      expect(other.msgs.some(x => x.t === 'inbound' && (x as Inbound).meta.event === 'session_message')).toBe(false)
    } finally {
      other.close()
    }
  })

  test('an offline topic queues messages again after a reconnect and delivers them on the next one', async () => {
    // The previous test's session must be gone first: wait for it, not a fixed time.
    for (let i = 0; i < 100 && d.sessionForProject('/tmp/other'); i++) await Bun.sleep(20)
    const thread = Number((d.store.topicForProject(group, '/tmp/other'))!.thread_id)
    tg.push(textMessage({ chat: Number(group), text: 'а теперь?', thread }))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('💤 Сессия этого проекта'))

    const again = new FakeClient()
    await again.connect({ cwd: '/tmp/other', projectRoot: '/tmp/other', claudePid: 7 })
    const resume = await again.inbound(x => x.meta.event === 'session_resume')
    expect(resume.content).toContain('а теперь?')
    expect(resume.meta.pending_count).toBe('1')
    again.close()
  })

  test('General: text goes to the author\'s own session, unknown commands do not; a user session has no topic', async () => {
    tg.push(textMessage({ chat: Number(group), text: 'общий вопрос' }))
    const m = await main.inbound(x => x.content === 'общий вопрос')
    expect(m.meta.thread_id).toBeUndefined()
    tg.push(textMessage({ chat: Number(group), text: '/nope' }))
    await Bun.sleep(300)
    expect(main.msgs.some(x => x.t === 'inbound' && (x as Inbound).content === '/nope')).toBe(false)
    expect(d.store.topicForProject(group, mainDir)).toBeFalsy()
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
    // One 🚀 per installed agent (Codex is installed on the test machine), or a single 🚀.
    expect(JSON.stringify(ts.body.reply_markup)).toMatch(new RegExp(`tm:run(claude)?:${otherThread}`))
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
      expect(text).toContain('🟠 <b>Claude</b> · подписка: Max 20x')
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
      expect(day).toMatch(/📂 проекты: 100% расхода · \$0\.50/)
      d.store.set('usage_period', null)
      // The same replies: today's cost in the session card and in the daily digest.
      const { sessionCostLine } = await import('../src/daemon/usage.ts')
      expect(sessionCostLine(d.sessions.get(sessionId)!)).toBe('💸 сегодня $0.50 · 3.0 млн ток.')
      // 🔢 the cost of one turn: the same entries since it began; almost all of it cache reads.
      const { turnCostLine } = await import('../src/daemon/usage.ts')
      const ses = d.sessions.get(sessionId)!
      expect(turnCostLine(ses, Date.now() - 60_000)).toBe('🔢 Ход: 3.0 млн ток. · кэш 100% · $0.50')
      expect(turnCostLine(ses, Date.now() - 60_000, Date.now(), true)).toMatch(/^🔢 \*\*Ход\*\* · .+\n3\.0 млн ток\. · кэш 100% · \*\*\$0\.50\*\*$/)
      expect(turnCostLine(ses, Date.now() + 60_000)).toBeNull()
      // FR-11: the same turn appended to its answer — the full table collapsed, the gist in a grey footer below.
      const { turnCostBlock } = await import('../src/daemon/usage.ts')
      const block = turnCostBlock(ses, Date.now() - 60_000)!
      expect(block).toStartWith('<details><summary>🔢 Расход хода</summary><table bordered striped compact>')
      expect(block).toContain('<tr><td>Запросов к модели</td><td align="right">3</td></tr><tr><td>Агент</td><td align="right">Claude Code</td></tr><tr><td>Модель</td>')
      expect(block).toMatch(/<td>Модель<\/td><td align="right">[^<]*opus-5-5 ×2/)
      expect(block).toContain('haiku-5-5 ×1')
      expect(block).toEndWith('</table></details><footer>🔢 1 мин · 3.0 млн ток. · кэш 100% · $0.50</footer>')
      expect(turnCostBlock(ses, Date.now() + 60_000)).toBeNull()
      // «🌙 Итоги дня»: one rich message at 00:00 — the chart inside, Claude, sessions; on by default (DIGEST_AT).
      const { sendDueReports } = await import('../src/daemon/reports.ts')
      tg.push(textMessage({ text: '/reports' }))
      const rs = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('📊 <b>Отчёты о потреблении</b>'))
      expect(String(rs.body.text)).toContain('✅ За сутки')
      const tomorrow = new Date(Date.now() + 86_400_000)
      tomorrow.setHours(0, 30, 0, 0)
      const photos = () => tg.callsOf('sendPhoto').length
      const riches = () => tg.callsOf('sendRichMessage').filter(c => String(c.body.rich_message).includes('🌙'))
      const before = photos()
      await sendDueReports(d, tomorrow)
      expect(riches().length).toBe(1)
      expect(photos()).toBe(before)
      const call = riches()[0]
      const rich = JSON.parse(String(call.body.rich_message)) as { markdown: string; media: { id: string; media: { type: string; media: string } }[] }
      expect(rich.markdown).toStartWith('# 🌙 Итоги дня · ')
      expect(rich.markdown).toContain('![](tg://photo?id=chart)')
      expect(rich.markdown).toContain('## 🟠 Claude')
      expect(rich.markdown).toContain('**$0.50** в ценах API · 3.0 млн ток.')
      expect(rich.markdown).toContain('| opus-5-5 | 0.45 | 2.0 млн | 89% |')
      expect(rich.markdown).toContain('| 📂 proj | $0.50 | — |')
      expect(rich.media[0]).toMatchObject({ id: 'chart', media: { type: 'photo' } })
      expect(rich.media[0].media.media).toStartWith('attach://')
      expect(Object.values(call.body)).toContain('(file)')
      await sendDueReports(d, tomorrow)
      expect(riches().length).toBe(1)
      // Without rich messages: the chart as a photo and the text, as before.
      tg.failures.set('sendRichMessage', { code: 400, description: 'Bad Request: rich messages unsupported' })
      try {
        tg.push(callbackQuery('rp:now:day'))
        await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('📊 <b>Статистика за сутки</b>'))
        expect(photos()).toBe(before + 1)
      } finally {
        tg.failures.delete('sendRichMessage')
      }
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
    const models = await tg.waitFor('editMessageText', x => String(x.body.text).startsWith('🧠 <b>Движок и модель</b>'))
    expect(JSON.stringify(models.body.reply_markup)).toContain(`sm:model:${s.id}:sonnet`)
    // Claude Code asks «Switch model?»: unanswered it holds every message, so its screen comes with keys.
    const capture = d.tmuxCapture
    d.tmuxCapture = async () => '   Switch model?\n   ❯ 1. Yes, switch to Sonnet 5.5\n     2. No, go back'
    tg.push(callbackQuery(`sm:model:${s.id}:sonnet`))
    await tg.waitFor('answerCallbackQuery', x => x.body.text === '➡️ /model claude-sonnet-5-5')
    const asked = await tg.waitFor('editMessageText', x => String(x.body.text).includes('❓ Claude Code спрашивает'))
    expect(String(asked.body.text)).toContain('No, go back')
    expect(JSON.stringify(asked.body.reply_markup)).toContain(`tx:v${s.id}:2`)
    d.tmuxCapture = capture
    // FR-15: the chosen model stays the project's — the next launch starts on it; ↩️ forgets it.
    const { projectEngine } = await import('../src/daemon/engines.ts')
    expect(projectEngine(d, '/tmp/ctl')).toEqual({ engine: 'claude', model: 'claude-sonnet-5-5' })
    tg.push(callbackQuery(`sm:mdl:${s.id}`))
    const marked = await tg.waitFor('editMessageText', x => String(x.body.text).includes('модель <b>claude-sonnet-5-5</b>'))
    expect(JSON.stringify(marked.body.reply_markup)).toContain('• 🧠 sonnet-5-5')
    tg.push(callbackQuery(`sm:mdldef:${s.id}`))
    await tg.waitFor('answerCallbackQuery', x => x.body.text === '↩️ Следующие запуски — на модели по умолчанию CLI')
    expect(projectEngine(d, '/tmp/ctl')).toEqual({ engine: 'claude' })

    // FR-14: the session did not take the line — nothing confirmed, its screen with keys instead.
    const { InputBlocked } = await import('../src/daemon/launch.ts')
    const typing = d.tmuxType
    d.tmuxType = async () => { throw new InputBlocked('') }
    tg.push(callbackQuery(`sm:cmp:${s.id}`))
    await tg.waitFor('answerCallbackQuery', x => x.body.text === '⛔ /compact не набрана: сессия ждёт ответа на экране')
    await tg.waitFor('editMessageText', x => String(x.body.text).includes('⛔ Не набрал'))
    d.tmuxType = typing
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
      // Brief: the limits in one line; normal and detailed: a section per subscription.
      expect(await renderDashboard(d, 1)).toContain('📊 Claude: 5 часов 3%')
      const limitsPart = await renderDashboard(d, 2)
      expect(limitsPart).toContain('📊 <b>Лимиты</b>\n\n🟠 <b>Claude</b>')
      expect(limitsPart).toMatch(/<blockquote>5 часов: <b>3%<\/b> ▰?▱+\n {3}сброс /)
      const { screenToRich: toRich } = await import('../src/rich.ts')
      expect(toRich(limitsPart)).toContain('<h4>📊 Лимиты</h4>')
      expect(toRich(limitsPart)).toContain('<h4>🟠 Claude')
      // Detail levels: brief — a line per session; normal — with the agent; detailed — with today's cost; the buttons switch them.
      const brief = await renderDashboard(d, 1)
      const full = await renderDashboard(d, 3)
      expect(brief.startsWith('🎛 <b>Пульт</b>')).toBe(true)
      expect(brief).not.toContain('</tg-emoji>')
      expect(await renderDashboard(d, 2)).toContain('</tg-emoji> Claude')
      expect(full.length).toBeGreaterThanOrEqual((await renderDashboard(d, 2)).length)
      tg.push(callbackQuery('dash:lv:3'))
      await tg.waitFor('answerCallbackQuery', c => c.body.text === '🔶 Подробно')
      expect(d.store.get('dash_detail')).toBe('3')
      d.store.set('dash_detail', null)
      // With a journal the status shows them as in /usage: percent, bar, reset.
      process.env.JOURNAL_CHAT_ID = '-5300'
      try {
        const status = await renderDashboard(d)
        expect(status).toContain('📊 <b>Лимиты</b>')
        expect(status).toContain('\n🟠 <b>Claude</b>')
        expect(status).toMatch(/5 часов: <b>3%<\/b> ▰?▱+\n {3}сброс .*\d\d:\d\d \(через /)
      } finally {
        delete process.env.JOURNAL_CHAT_ID
      }

      // On the minute: a window over a threshold gets a "tokens are back" at its reset (here: already due).
      const { scheduleResetNotice, usageKeyboard } = await import('../src/daemon/usage.ts')
      // resets_at jitters between calls: three schedules of one window → one notice.
      let at0 = Date.now() - 31_000
      if (Math.abs((at0 % 60_000) - 30_000) < 1_000) at0 -= 1_500
      scheduleResetNotice(d, 'Тест', new Date(at0 - 400))
      scheduleResetNotice(d, 'Тест', new Date(at0 + 300))
      scheduleResetNotice(d, 'Тест', new Date(at0))
      await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('✅ Токены обновились: лимит «Тест» сброшен'), 3_000)
      await Bun.sleep(400)
      expect(tg.callsOf('sendMessage').filter(c => String(c.body.text).startsWith('✅ Токены обновились: лимит «Тест»')).length).toBe(1)
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
    // F09: a fixed interactive command line, not the argv of whatever runs the tests (`claude -p` read as print mode).
    await p.connect({ cwd: '/tmp/nochan', projectRoot: '/tmp/nochan', passive: true, claudePid: 987654 })
    const nochan = [...d.sessions.values()].find(x => x.cwd === '/tmp/nochan')!
    nochan.argv = ['claude', '--model', 'opus']
    tg.push(textMessage({ text: '/sessions' }))
    const r = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('📋 <b>Сессии</b>') && String(c.body.text).includes('nochan'))
    const text = String(r.body.text)
    expect(text).toContain('👻 <b>Без канала</b> (1)')
    expect(text).toContain('без канала')
    expect(text).toContain(`<code>${settings.launchCmd} `)
    expect(text.indexOf('👻')).toBeGreaterThan(text.indexOf('👤 <b>Владелец</b>'))
    expect(text).not.toContain('👑 MAIN_DIR')
    p.close()
  })

  test('/clear, /compact, /model, /cost in a session topic: answered by the daemon, never a turn for the model', async () => {
    const s = d.sessions.get(sessionId)!
    const thread = s.topic!.threadId
    const before = client.msgs.filter(m => m.t === 'inbound').length
    // Not in tmux: said so, still no turn.
    tg.push(textMessage({ chat: Number(s.topic!.chatId), thread, text: '/clear' }))
    await tg.waitFor('sendMessage', x => x.body.text === 'Сессия не в tmux — команды не отправить.' && x.body.message_thread_id === thread)
    const pane = s.tmuxPane
    s.tmuxPane = '%9'
    tg.push(textMessage({ chat: Number(s.topic!.chatId), thread, text: '/clear' }))
    const c = await tg.waitFor('sendMessage', x => String(x.body.text).startsWith('Очистить разговор сессии') && x.body.message_thread_id === thread)
    expect(JSON.stringify(c.body.reply_markup)).toContain(`sm:clrok:${sessionId}`)
    tg.push(textMessage({ chat: Number(s.topic!.chatId), thread, text: '/compact@test_bot' }))
    const k = await tg.waitFor('sendMessage', x => String(x.body.text).startsWith('Сжать разговор сессии') && x.body.message_thread_id === thread)
    expect(JSON.stringify(k.body.reply_markup)).toContain(`sm:cmp:${sessionId}`)
    tg.push(textMessage({ chat: Number(s.topic!.chatId), thread, text: '/model opus' }))
    await tg.waitFor('sendMessage', x => String(x.body.text).startsWith('🧠 <b>Движок и модель</b> · сессия') && x.body.message_thread_id === thread)
    tg.push(textMessage({ chat: Number(s.topic!.chatId), thread, text: '/cost' }))
    await tg.waitFor('sendMessage', x => String(x.body.text).includes(`#${sessionId}`) && x.body.message_thread_id === thread && JSON.stringify(x.body.reply_markup ?? '').includes(`sm:g:${sessionId}:c`))
    // A member may not; nothing of it reaches the session.
    tg.push(textMessage({ from: 333, chat: Number(s.topic!.chatId), thread, text: '/clear' }))
    await Bun.sleep(300)
    expect(client.msgs.filter(m => m.t === 'inbound').length).toBe(before)
    s.tmuxPane = pane
  })

  test('FR-9: status, stop, «ок», double sends and Claude Code commands never wake the session', async () => {
    const s = d.sessions.get(sessionId)!
    const chat = s.topic!.chatId
    const thread = s.topic!.threadId
    const inbound = () => client.msgs.filter(m => m.t === 'inbound').length
    const say = (text: string, from = 111) => tg.push(textMessage({ from, chat: Number(chat), thread, text }))
    const out = (text: string) => d.store.addMessage({ chat_id: chat, thread_id: thread, message_id: 70000 + Math.floor(Math.random() * 9999), direction: 'out', from_id: '999', from_name: 'bot', date: Math.floor(Date.now() / 1000), text, kind: 'text', file_id: null, reply_to: null, quote: null, forward: null })
    const before = inbound()
    const status = s.status
    s.status = 'idle'

    say('статус')
    await tg.waitFor('sendMessage', c => String(c.body.text).includes(`#${sessionId}, активность`) && c.body.message_thread_id === thread)

    out('Готово, всё сделал.')
    say('ок')
    await tg.waitFor('setMessageReaction', c => JSON.stringify(c.body.reaction).includes('👌'))

    const pane = s.tmuxPane
    s.tmuxPane = '%9'
    s.status = 'working'
    say('стоп')
    await Bun.sleep(300)
    expect(s.notes.some(n => n.includes('⏹'))).toBe(true)
    s.status = 'idle'
    s.turn = null
    s.stopRequest = undefined

    const typed: string[] = []
    const ty = d.tmuxType
    d.tmuxType = async (_t, text) => { typed.push(text) }
    say('/context')
    const offer = await tg.waitFor('sendMessage', c => String(c.body.text).includes('похоже на команду Claude Code'))
    const id = /fx:type:([0-9a-f]{8})/.exec(JSON.stringify(offer.body.reply_markup))![1]
    tg.push(callbackQuery(`fx:type:${id}`, { chat: Number(chat) }))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === '➡️ /context')
    expect(typed).toEqual(['/context'])
    d.tmuxType = ty
    s.tmuxPane = pane
    expect(inbound()).toBe(before)

    // A question was asked: «ок» is an answer and goes; the same text again at once is a double tap.
    out('Сделать так?')
    say('ок!')
    // (After ⏹ the session gets a note about it in front of the next message.)
    await client.inbound(m => m.content.endsWith('ок!'))
    say('проверка дубля')
    say('проверка дубля')
    await Bun.sleep(400)
    expect(client.msgs.filter(m => m.t === 'inbound' && (m as Inbound).content === 'проверка дубля').length).toBe(1)
    expect(d.store.get('fr9:saved')).toBeTruthy()
    s.status = status
    s.turn = null
    s.notes = []
  })

  test('/sessions is a menu: a session button opens its card, settings apply to its topic, « returns', async () => {
    tg.push(textMessage({ text: '/sessions' }))
    const r = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('📋 <b>Сессии</b>') && String(c.body.text).includes('📂 <b>Проекты</b>'))
    const listText = String(r.body.text)
    expect(listText).toMatch(/\n\d+\. 📂 <b>proj<\/b> · /)
    // Sections in order — the owner's, the users', the projects' — numbered through; each line with the agent.
    const at = (x: string) => listText.indexOf(x)
    expect(at('👤 <b>Владелец</b>')).toBeLessThan(at('📂 <b>Проекты</b>'))
    const nums = [...listText.matchAll(/\n(\d+)\. /g)].map(m => Number(m[1]))
    expect(nums).toEqual(nums.map((_, i) => i + 1))
    expect(listText).toContain('🤖</tg-emoji> Claude')
    const kb = JSON.stringify(r.body.reply_markup)
    // Buttons preserve the agent and status around the project name.
    const btn = (r.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat().find(b => b.callback_data === `sm:s:${sessionId}`)!
    expect(btn.text).toMatch(/^\d+\. proj (💤|⚙️|🔐)$/u)
    expect(kb).toContain(`sm:s:${sessionId}`)
    expect(kb).toContain('sm:list')

    const s = d.sessions.get(sessionId)!
    const key = `${s.topic!.chatId}:${s.topic!.threadId}`
    tg.push(callbackQuery(`sm:s:${sessionId}`))
    const top = await tg.waitFor('editMessageText', c => String(c.body.text).includes(`#${sessionId}`) && JSON.stringify(c.body.reply_markup ?? '').includes(`sm:g:${sessionId}:n`))
    expect(String(top.body.text)).toContain('📂 <b>proj</b>')
    // The card keeps the groups; their buttons are one tap deeper.
    expect(JSON.stringify(top.body.reply_markup)).toContain(`sm:g:${sessionId}:c`)
    expect(JSON.stringify(top.body.reply_markup)).toContain(`sm:g:${sessionId}:m`)
    expect(JSON.stringify(top.body.reply_markup)).not.toContain(`sm:v:${sessionId}`)
    tg.push(callbackQuery(`sm:g:${sessionId}:n`))
    const card = await tg.waitFor('editMessageText', c => String(c.body.text).includes(`#${sessionId}`) && String(c.body.text).includes('в топике'))
    const ckb = JSON.stringify(card.body.reply_markup)
    expect(ckb).toContain(`sm:v:${sessionId}:2`)
    expect(ckb).toContain(`sm:n:${sessionId}:always`)
    expect(ckb).toContain('• 🔔1')
    expect(ckb).toContain(`"sm:s:${sessionId}"`)

    tg.push(callbackQuery(`sm:v:${sessionId}:2`))
    await tg.waitFor('editMessageText', c => JSON.stringify(c.body.reply_markup ?? '').includes('• 📢2'))
    expect(prefsFor(s.topic!.chatId, s.topic!.threadId).verbose).toBe(2)
    tg.push(callbackQuery(`sm:n:${sessionId}:always`))
    await tg.waitFor('editMessageText', c => JSON.stringify(c.body.reply_markup ?? '').includes('• ✅ всегда'))
    expect(prefsFor(s.topic!.chatId, s.topic!.threadId).notifyDone).toBe('always')
    setPref(key, { verbose: 1, notifyDone: 'long' })

    tg.push(callbackQuery(`sm:g:${sessionId}:m`))
    await tg.waitFor('editMessageText', c => JSON.stringify(c.body.reply_markup ?? '').includes(`sm:ar:${sessionId}`))
    tg.push(callbackQuery(`sm:ar:${sessionId}`))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('Архивировать «proj»'))
    tg.push(callbackQuery(`sm:s:${sessionId}`))
    await tg.waitFor('editMessageText', c => String(c.body.text).includes(`#${sessionId}`) && JSON.stringify(c.body.reply_markup ?? '').includes('sm:list'))
    tg.push(callbackQuery('sm:list'))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('📋 <b>Сессии</b>'))
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

  test('between turns: a background agent\'s tool call opens no turn; a tool-opened turn that goes quiet with an idle screen ends', async () => {
    const s = d.sessions.get(sessionId)!
    const hook = (event: string, data: Record<string, unknown>) => fetch(`http://127.0.0.1:${settings.httpPort}/hook`, {
      method: 'POST', headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event, claudePid: 424242, data, at: Date.now() }),
    })
    await hook('Stop', {})
    await Bun.sleep(5)
    await hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/x/memory.md' }, agent_id: 'a1', agent_type: 'memory' })
    expect(s.turn).toBeNull()
    await hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x/a.ts' } })
    expect(s.turn?.byHook).toBe(true)
    const { closePhantomTurns } = await import('../src/daemon/watchdog.ts')
    const saved = { capture: d.tmuxCapture, pane: s.tmuxPane }
    s.tmuxPane = s.tmuxPane ?? '%77'
    try {
      d.tmuxCapture = async () => '✻ Reading… (esc to interrupt)'
      await closePhantomTurns(d, Date.now() + 61_000)
      expect(s.turn).not.toBeNull()
      d.tmuxCapture = async () => '> \n  ? for shortcuts'
      await closePhantomTurns(d, Date.now() + 10_000)
      expect(s.turn).not.toBeNull()
      await closePhantomTurns(d, Date.now() + 61_000)
      expect(s.turn).toBeNull()
      expect(s.status).toBe('idle')
    } finally {
      d.tmuxCapture = saved.capture
      s.tmuxPane = saved.pane
    }
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
    const md = (c: { body: Record<string, unknown> }) => String((c.body.rich_message as { markdown?: string } | undefined)?.markdown ?? '')
    // The narration stays among the steps (💬), the answer below the divider is only the answer.
    const answer = (c: { body: Record<string, unknown> }) => md(c).split('---').slice(1).join('---')
    const prog = await tg.waitFor('editMessageText', c => answer(c).includes('Итог: всё') && answer(c).includes('готово.') && !answer(c).includes('Сейчас посмотрю'))
    expect(md(prog)).toContain('💬 Сейчас посмотрю файлы.')
    const r = await client.call('reply', { chat_id: group, use_last_message: true, format: 'rich' })
    expect(r.ok).toBe(true)
    const edited = await tg.waitFor('editMessageText', c => String((c.body.rich_message as { markdown?: string } | undefined)?.markdown ?? '').startsWith('Итог: всё'))
    expect((edited.body.rich_message as { markdown: string }).markdown).toBe('Итог: всё  \nготово.')
    // Ending with a new message (⚙️ «🆕 конец: новым»): the answer comes as its own message, the progress goes away.
    setPref(`${group}:${thread}`, { streamFinal: 'new' })
    tg.push(textMessage({ chat: Number(group), text: 'ещё раз', thread }))
    await client.inbound(x => x.content === 'ещё раз')
    await hook('MessageDisplay', { delta: 'Итог: всё ' })
    await hook('MessageDisplay', { delta: 'готово.' })
    await client.call('reply', { chat_id: group, use_last_message: true })
    const sent = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('Итог: всё'))
    expect(String(sent.body.text)).toBe('Итог: всё \nготово.')
    setPref(`${group}:${thread}`, { streamFinal: 'edit' })
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

  test('FR-12/13: a rich reply gets 📋 copy buttons (asked for and from ```bash), long code folded; the plan shows in the progress', async () => {
    const thread = d.sessions.get(sessionId)!.topic!.threadId
    const hook = (event: string, data: Record<string, unknown>) => fetch(`http://127.0.0.1:${settings.httpPort}/hook`, {
      method: 'POST', headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event, claudePid: 424242, data }),
    })
    setPref(`${group}:${thread}`, { streamFinal: 'new' })
    tg.push(textMessage({ chat: Number(group), text: 'план и команда', thread }))
    await client.inbound(x => x.content === 'план и команда')
    await hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Шаг один', status: 'completed' }, { content: 'Шаг два', status: 'in_progress' }] } })
    const md = (c: { body: Record<string, unknown> }) => String((c.body.rich_message as { markdown?: string } | undefined)?.markdown ?? '')
    await tg.waitFor('editMessageText', c => md(c).includes('- [x] Шаг один') && md(c).includes('**Шаг два**'))
    const code = Array.from({ length: 18 }, (_, i) => `x${i}`).join('\n')
    const r = await client.call('reply', { chat_id: group, format: 'rich', text: `Запустите:\n\n\`\`\`bash\nbun test\n\`\`\`\n\n\`\`\`ts\n${code}\n\`\`\``, copy: [{ label: '📋 id', text: 'abc-123' }] })
    expect(r.ok).toBe(true)
    const sent = await tg.waitFor('sendRichMessage', c => md(c).startsWith('Запустите'))
    expect(md(sent)).toContain('<details><summary>📄 ts · 18 строк</summary>')
    const kb = JSON.stringify(sent.body.reply_markup)
    expect(kb).toContain('"copy_text":{"text":"abc-123"}')
    expect(kb).toContain('"copy_text":{"text":"bun test"}')
    // With buttons too: a rich message (tables, custom emoji), the buttons under it.
    const q = await client.call('reply', { chat_id: group, format: 'rich', text: '| a | b |\n|---|---|\n| x | ![🤖](tg://emoji?id=123) |', buttons: ['Да', 'Нет'] })
    expect(q.ok).toBe(true)
    const rq = await tg.waitFor('sendRichMessage', c => md(c).includes('tg://emoji?id=123'))
    expect(JSON.stringify(rq.body.reply_markup)).toContain('Да')
    setPref(`${group}:${thread}`, { streamFinal: 'edit' })
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
      body: JSON.stringify({ event, claudePid: 424242, data, at: Date.now() }),
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

    tg.push(callbackQuery(`sm:g:${sessionId}:m`))
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

    // FR-7: a session's task, late after downtime, repeating; a note wakes no session; cancel_reminder.
    const task = listReminders(d)[0]
    expect(task.by).toBe('session')
    await fireDue(d, task.at + 30 * 60_000)
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('⏰🤖 проверь деплой') && String(c.body.text).includes('опоздало на 30 мин'))
    const late = await client.inbound(x => x.meta.event === 'reminder' && x.content.includes('проверь деплой'))
    expect(late.meta.late_min).toBe('30')
    expect(late.meta.reminder_by).toBe('session')
    expect(late.meta.user_role).toBe('owner')
    expect(late.content).toContain('Задача, которую вы поставили себе')

    expect((await client.call('remind', { text: 'пинг', every_minutes: 10 })).ok).toBe(true)
    const rep = listReminders(d).find(x => x.text === 'пинг')!
    await fireDue(d, rep.at + 1000)
    await client.inbound(x => x.meta.event === 'reminder' && x.content.includes('пинг') && x.meta.repeats === 'true')
    expect(listReminders(d).find(x => x.id === rep.id)!.at).toBe(rep.at + 10 * 60_000)
    expect((await client.call('cancel_reminder', { id: rep.id })).ok).toBe(true)
    expect(listReminders(d).some(x => x.id === rep.id)).toBe(false)

    expect((await client.call('remind', { text: 'только людям', in_minutes: 1, mode: 'note' })).ok).toBe(true)
    const note = listReminders(d).find(x => x.text === 'только людям')!
    const before = client.msgs.length
    await fireDue(d, note.at + 1000)
    await tg.waitFor('sendMessage', c => String(c.body.text) === '⏰🤖 только людям')
    await Bun.sleep(200)
    expect(client.msgs.slice(before).some(x => x.t === "inbound" && (x as Inbound).content.includes("только людям"))).toBe(false)
  })

  test('stop button without tmux only notes the stop for the next message', async () => {
    tg.push(callbackQuery(`stop:${sessionId}`, { chat: Number(group) }))
    await tg.waitFor('answerCallbackQuery', c => String(c.body.text).includes('tmux'))
    expect(d.sessions.get(sessionId)!.notes.length).toBe(1)
  })

  test('after ⏹ the stopped turn\'s late hooks keep the session idle; the next message makes it working', async () => {
    const s = d.sessions.get(sessionId)!
    const thread = s.topic!.threadId
    const hook = (event: string, data: Record<string, unknown>) => fetch(`http://127.0.0.1:${settings.httpPort}/hook`, {
      method: 'POST', headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event, claudePid: 424242, data }),
    })
    const pane = s.tmuxPane
    s.tmuxPane = '%9'
    // F01: ⏹ goes through the daemon's tmux adapter — the user's real tmux is never touched.
    const savedKeys = d.tmuxKeys
    const keys: string[][] = []
    d.tmuxKeys = async (target, k) => { keys.push([target, ...k]) }
    tg.push(textMessage({ chat: Number(group), text: 'расскажи анекдот', thread }))
    await client.inbound(x => x.content.endsWith('расскажи анекдот'))
    await hook('MessageDisplay', { delta: 'Жена отправляет мужа' })
    expect(s.status).toBe('working')
    const beforeStopAck = tg.calls.length
    tg.push(callbackQuery(`stop:${sessionId}`, { chat: Number(group) }))
    await tg.waitFor('answerCallbackQuery', c => tg.calls.indexOf(c) >= beforeStopAck && c.body.text === 'Команда остановки отправлена')
    const captureStop = d.tmuxCapture
    d.tmuxCapture = async () => '❯ '
    const { verifyStop } = await import('../src/daemon/stopcheck.ts')
    await verifyStop(d, s, s.stoppedAt!)
    d.tmuxCapture = captureStop
    expect(s.status).toBe('idle')
    expect(keys).toEqual([['%9', 'Escape']])
    d.tmuxKeys = savedKeys
    const { realTmuxLog } = await import('./setup.ts')
    expect(existsSync(realTmuxLog) ? readFileSync(realTmuxLog, 'utf8') : '').not.toContain('send-keys')
    // The tail of the streamed text arrives after the Escape; no Stop hook follows.
    await hook('MessageDisplay', { delta: 'в магазин.' })
    await hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x/a.ts' } })
    expect(s.status).toBe('idle')
    expect(s.turn).toBeNull()
    tg.push(textMessage({ chat: Number(group), text: 'ещё один', thread }))
    const m = await client.inbound(x => x.content.includes('ещё один'))
    expect(m.content).toContain('⏹')
    expect(s.status).toBe('working')
    await hook('MessageDisplay', { delta: 'Сколько программистов' })
    expect(s.status).toBe('working')
    await hook('Stop', {})
    expect(s.status).toBe('idle')
    s.tmuxPane = pane
  })

  test('FR-16: a Codex session gets messages with codex queue (pasted once its input line is up, before its thread is known), no stream_answer', async () => {
    const c = new FakeClient()
    await c.connect({ cwd: '/tmp/cx', projectRoot: '/tmp/cx', claudePid: 616161, tmuxPane: '%61', engine: 'codex' } as never)
    const s = [...d.sessions.values()].find(x => x.claudePid === 616161)!
    expect(s.engine).toBe('codex')
    for (let i = 0; i < 100 && !s.topic; i++) await Bun.sleep(20)
    const saved = { type: d.tmuxType, queue: d.codexQueue, capture: d.tmuxCapture }
    const typed: string[] = []
    const opts: unknown[] = []
    const queued: [string, string][] = []
    // Still starting: no input line for a while — the message waits for it.
    let ready = false
    d.tmuxCapture = async () => (ready ? '  >_ OpenAI Codex\n\n› Ask Codex to do anything\n' : '  >_ OpenAI Codex\n  Booting MCP server\n')
    d.tmuxType = async (_pane, text, o) => { typed.push(text); opts.push(o) }
    d.codexQueue = async (thread, text) => { queued.push([thread, text]) }
    try {
      tg.push(textMessage({ chat: Number(group), text: 'первое\nсообщение', thread: s.topic!.threadId }))
      await Bun.sleep(300)
      expect(typed).toEqual([])
      ready = true
      for (let i = 0; i < 150 && !typed.length; i++) await Bun.sleep(20)
      // One bracketed paste: the newlines stay, Enter does not send it early.
      expect(typed[0]).toMatch(/^<channel source="telegram-bewitched" .*>\nпервое\nсообщение\n<\/channel>$/)
      expect(opts[0]).toEqual({ paste: true })
      expect(typed[0]).not.toContain('stream_answer')
      expect(c.msgs.some(m => m.t === 'inbound')).toBe(false)
      s.claude.sessionId = '01a19724-efea'
      tg.push(textMessage({ chat: Number(group), text: 'второе', thread: s.topic!.threadId }))
      for (let i = 0; i < 100 && !queued.length; i++) await Bun.sleep(20)
      expect(queued[0][0]).toBe('01a19724-efea')
      expect(queued[0][1]).toContain('\nвторое\n</channel>')
      // After a turn interrupted with Esc Codex does not take its queue by itself: the message is pasted.
      d.tmuxCapture = async () => '■ Conversation interrupted - use /feedback if something went wrong\n› Ask Codex to do anything\n'
      const pasted = typed.length
      tg.push(textMessage({ chat: Number(group), text: 'третье', thread: s.topic!.threadId }))
      for (let i = 0; i < 100 && typed.length === pasted; i++) await Bun.sleep(20)
      expect(typed.at(-1)).toContain('\nтретье\n</channel>')
      expect(queued.length).toBe(1)
    } finally {
      Object.assign(d, { tmuxType: saved.type, codexQueue: saved.queue, tmuxCapture: saved.capture })
      c.close()
    }
  })

  test('FR-16: a message Codex did not take: no «working» left behind, the chat gets the screen with keys; Claude\'s token pause does not hold it', async () => {
    const { InputBlocked } = await import('../src/daemon/launch.ts')
    const c = new FakeClient()
    await c.connect({ cwd: '/tmp/cx2', projectRoot: '/tmp/cx2', claudePid: 626262, tmuxPane: '%62', engine: 'codex' } as never)
    const s = [...d.sessions.values()].find(x => x.claudePid === 626262)!
    for (let i = 0; i < 100 && !s.topic; i++) await Bun.sleep(20)
    const saved = { type: d.tmuxType, capture: d.tmuxCapture }
    d.tmuxCapture = async () => '› [Pasted Content 1274 chars]\n  GPT-6.1-Sol default'
    d.tmuxType = async () => { throw new InputBlocked('› [Pasted Content 1274 chars]') }
    // Claude is out of tokens: a Codex session is not held by it.
    d.store.set('tokens_pause', JSON.stringify({ kind: 'subscription', until: Date.now() + 3600_000, at: Date.now(), tries: 0 }))
    try {
      tg.push(textMessage({ chat: Number(group), text: 'расскажи про лимиты', thread: s.topic!.threadId }))
      const note = await tg.waitFor('sendMessage', x => String(x.body.text).includes('Сообщение не дошло до Codex') && x.body.message_thread_id === s.topic!.threadId)
      expect(String(note.body.text)).toContain('[Pasted Content 1274 chars]')
      expect(JSON.stringify(note.body.reply_markup)).toContain(`tx:v${s.id}:e`)
      expect(s.status).toBe('idle')
      expect(s.turn).toBeNull()
    } finally {
      d.store.set('tokens_pause', null)
      Object.assign(d, { tmuxType: saved.type, tmuxCapture: saved.capture })
      c.close()
    }
  })

  test('FR-19: a question on a screen goes to the chat once (after two checks); the launch lock holds while the launch window lives; a replaced tmux server is reported', async () => {
    const { checkQuestions } = await import('../src/daemon/watchdog.ts')
    const { launchOnce } = await import('../src/daemon/launch.ts')
    const { checkHealth } = await import('../src/daemon/health.ts')
    const s = d.sessions.get(sessionId)!
    const saved = { pane: s.tmuxPane, capture: d.tmuxCapture, paneId: d.tmuxPaneId }
    s.tmuxPane = '%71'
    let screen = '  Hooks need review\n› 1. Review hooks\n  2. Trust all and continue\n  enter confirm · esc skip'
    d.tmuxCapture = async () => screen
    const asked = (x: { body: Record<string, unknown> }) => String(x.body.text).includes(`❓ Сессия #${sessionId} ждёт ответа на экране`)
    try {
      await checkQuestions(d)
      expect(tg.callsOf('sendMessage').filter(asked).length).toBe(0)
      await checkQuestions(d)
      const q = await tg.waitFor('sendMessage', asked)
      expect(JSON.stringify(q.body.reply_markup)).toContain(`tx:v${s.id}:2`)
      await checkQuestions(d)
      expect(tg.callsOf('sendMessage').filter(asked).length).toBe(1)
      screen = '› Ask Codex to do anything'
      await checkQuestions(d)
      screen = '  Trust this folder?\n› 1. Trust and continue\n  enter continue · esc quit'
      await checkQuestions(d)
      await checkQuestions(d)
      expect(tg.callsOf('sendMessage').filter(asked).length).toBe(2)

      // A launch that waits on a question keeps the lock past RELAUNCH_MS while its window lives.
      d.launching.set('/tmp/lock', Date.now() - 3600_000)
      d.launchWindows.set('/tmp/lock', '7')
      d.tmuxPaneId = async () => '%7'
      expect(await launchOnce(d, '/tmp/lock', {})).toEqual({ ok: false, skipped: true, error: '', window: '7' })
      d.tmuxPaneId = async () => null
      expect((await launchOnce(d, '/tmp/lock', {})).ok).toBe(true)

      const state = { tmuxPid: null as number | null, oomKills: null as number | null }
      let pid = 100
      let oom = 3
      const reads = { tmuxPid: async () => pid, oomKills: () => oom }
      await checkHealth(d, state, reads)
      pid = 200
      oom = 5
      await checkHealth(d, state, reads)
      await tg.waitFor('sendMessage', x => String(x.body.text).includes('tmux-сервер перезапустился (pid 100 → 200)'))
      await tg.waitFor('sendMessage', x => String(x.body.text).includes('нехватки памяти: 2 за последние 30 с'))
    } finally {
      s.tmuxPane = saved.pane
      Object.assign(d, { tmuxCapture: saved.capture, tmuxPaneId: saved.paneId })
      d.launching.delete('/tmp/lock')
      d.launchWindows.delete('/tmp/lock')
    }
  })

  test('/usage counts Codex too: its plan, windows, tokens by model and by session', async () => {
    const { mkdirSync, writeFileSync } = await import('fs')
    const { join } = await import('path')
    const { usageReport } = await import('../src/daemon/usage.ts')
    const now = Date.now()
    const dir = join(process.env.CODEX_HOME!, 'sessions', '2026', '11', '02')
    mkdirSync(dir, { recursive: true })
    const at = (ms: number) => new Date(now - ms).toISOString()
    const rl = { primary: { used_percent: 12, window_minutes: 300, resets_at: Math.round(now / 1000) + 3600 }, secondary: { used_percent: 4, window_minutes: 10080, resets_at: Math.round(now / 1000) + 86_400 }, plan_type: 'plus' }
    writeFileSync(join(dir, 'rollout-test.jsonl'), [
      { timestamp: at(60_000), type: 'session_meta', payload: { cwd: '/tmp/cxusage' } },
      { timestamp: at(59_000), type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      { timestamp: at(50_000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 30_000, cached_input_tokens: 20_000, output_tokens: 500 } }, rate_limits: rl } },
    ].map(x => JSON.stringify(x)).join('\n'))
    const text = await usageReport(d, now, 'd')
    // Its own section, after Claude's: plan, windows, tokens, models and sessions of Codex only.
    const codex = text.slice(text.indexOf('⚫️ <b>Codex</b>'))
    expect(text.indexOf('🟠 <b>Claude</b>')).toBeLessThan(text.indexOf('⚫️ <b>Codex</b>'))
    expect(codex).toStartWith('⚫️ <b>Codex</b> · подписка: plus')
    expect(codex).toContain('5 часов: <b>12%</b>')
    expect(codex).toContain('по последнему запросу')
    expect(codex).toContain('5 часов: 31 тыс. ток.')
    expect(codex).toContain('gpt-6.1-sol: 31 тыс. ток.')
    expect(codex).toContain('cxusage: 31 тыс. ток.')
    // Who spends Codex: in tokens, not dollars.
    expect(codex).toContain('👥 <b>Кто тратит</b>, сутки')
    expect(codex).toContain('📂 проекты: 100% токенов · 31 тыс. ток.')
    expect(text.slice(0, text.indexOf('⚫️ <b>Codex</b>'))).not.toContain('gpt-6.1-sol')
    const { limitsHtml, limitsLine } = await import('../src/daemon/usage.ts')
    expect(limitsHtml(now)).toContain('⚫️ <b>Codex</b> · plus\n<blockquote>5 часов: <b>12%</b>')
    expect(limitsLine(now)).toContain('Codex: 5 часов 12% · неделя 4%')
    // The turn's cost of a Codex session: from its rollouts, tokens and cache, no $.
    const { turnCostLine, turnCostBlock, sessionCostLine } = await import('../src/daemon/usage.ts')
    const cx = { engine: 'codex', cwd: '/tmp/cxusage', projectKey: '/tmp/cxusage' } as never
    expect(turnCostLine(cx, now - 120_000, now)).toBe('🔢 Ход: 31 тыс. ток. · кэш 66%')
    expect(turnCostBlock(cx, now - 120_000, now)).not.toContain('В ценах API')
    expect(sessionCostLine(cx, now)).toBe('💸 сегодня 31 тыс. ток. (Codex)')
    // Codex's windows cross the alert thresholds too (85% ≥ 80).
    writeFileSync(join(dir, 'rollout-alert.jsonl'), [
      { timestamp: at(30_000), type: 'session_meta', payload: { cwd: '/tmp/cxusage' } },
      { timestamp: at(20_000), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { ...rl, primary: { ...rl.primary, used_percent: 85 } } } },
    ].map(x => JSON.stringify(x)).join('\n'))
    const { checkLimits } = await import('../src/daemon/usage.ts')
    process.env.USAGE_API_URL = 'http://127.0.0.1:9/'
    try {
      await checkLimits(d, Date.now())
    } finally {
      delete process.env.USAGE_API_URL
    }
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('⚠️ Лимит «Codex: 5 часов»: <b>85%</b>'))
  })

  test('a message with no sign of life: «не берёт сообщение» once; ♻️ ends the session (/exit, then Ctrl-C) and starts it again', async () => {
    const { checkTurns } = await import('../src/daemon/watchdog.ts')
    const { endTiming } = await import('../src/daemon/launch.ts')
    const c = new FakeClient()
    await c.connect({ cwd: '/tmp/stuck', projectRoot: '/tmp/stuck', claudePid: 515151, tmuxPane: '%77' })
    const s = [...d.sessions.values()].find(x => x.claudePid === 515151)!
    for (let i = 0; i < 100 && !s.topic; i++) await Bun.sleep(20)
    const saved = { keys: d.tmuxKeys, type: d.tmuxType, capture: d.tmuxCapture, ms: endTiming.checkMs }
    const keys: string[] = []
    // /exit lands in a menu and does nothing; the second Ctrl-C closes Claude.
    d.tmuxKeys = async (_pane, k) => {
      keys.push(...k)
      if (keys.filter(x => x === 'C-c').length === 2) c.close()
    }
    d.tmuxType = async (_pane, text) => { keys.push(text) }
    d.tmuxCapture = async () => '❯ /exit\n  Rewind to a message'
    endTiming.checkMs = 1000
    try {
      tg.push(textMessage({ chat: Number(group), text: 'привет, запускаемся', thread: s.topic!.threadId }))
      await c.inbound(x => x.content.endsWith('привет, запускаемся'))
      const stuck = (x: { body: Record<string, unknown> }) => String(x.body.text).startsWith(`⚠️ Сессия #${s.id} не берёт сообщение`)
      await checkTurns(d)
      expect(tg.callsOf('sendMessage').some(stuck)).toBe(false)
      await checkTurns(d, Date.now() + 121_000)
      const warn = await tg.waitFor('sendMessage', stuck)
      expect(String(warn.body.text)).toContain('Rewind to a message')
      expect(warn.body.message_thread_id).toBe(s.topic!.threadId)
      expect(JSON.stringify(warn.body.reply_markup)).toContain(`wd:re:${s.id}`)
      await checkTurns(d, Date.now() + 300_000)
      expect(tg.callsOf('sendMessage').filter(stuck).length).toBe(1)

      const before = launched.length
      tg.push(callbackQuery(`wd:re:${s.id}`, { chat: Number(group) }))
      await tg.waitFor('editMessageText', x => String(x.body.text).startsWith(`♻️ Перезапускаю сессию #${s.id}`), 5000)
      expect(keys).toEqual(['Escape', '/exit', 'C-c', 'C-c'])
      expect(launched.slice(before)).toEqual(['/tmp/stuck'])
    } finally {
      Object.assign(d, { tmuxKeys: saved.keys, tmuxType: saved.type, tmuxCapture: saved.capture })
      endTiming.checkMs = saved.ms
      d.launching.delete('/tmp/stuck')
    }
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
      expect(launches).toEqual([`${process.env.USERS_DIR}/555 claude-user-555`])
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
    try {
      newUsers(d) // baseline
      const a = loadAccess()
      a.allowFrom.push('777')
      saveAccess(a)
      expect(newUsers(d)).toEqual(['777'])
      expect(newUsers(d)).toEqual([])
      await onUserAdded(d, '777')
      expect(launches).toEqual([`${process.env.USERS_DIR}/777 claude-user-777`])
      const note = tg.callsOf('sendMessage').find(c => String(c.body.text).startsWith('👥 <b>777</b> в списке доступа'))!
      expect(String(note.body.chat_id)).toBe('111')
      expect(note.body.reply_markup).toBeUndefined()
      expect(String(note.body.text)).toContain('<code>/telegram-bewitched:access remove 777</code>')
      expect(tg.callsOf('sendMessage').some(c => String(c.body.text).startsWith('Привет! Я дал тебе доступ'))).toBe(true)
    } finally {
      d.launchSession = ok
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
    const c = new FakeClient()
    await c.connect({ cwd: dir, projectRoot: dir, tmuxPane: '%31', claudePid: claude.pid })
    const s = d.userSession('888')!

    tg.push(callbackQuery(`sm:g:${s.id}:m`))
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
    // The owner's own session (the «main» fixture) is off for this check.
    main.close()
    await Bun.sleep(200)
    const offline = await sessionsList(d)
    expect(offline.text).toContain('⏻ не запущена')
    expect(offline.kb.inline_keyboard.flat().some(b => 'callback_data' in b && b.callback_data === 'sm:owner')).toBe(true)
    const u = new FakeClient()
    await u.connect({ cwd: `${process.env.USERS_DIR}/111`, projectRoot: `${process.env.USERS_DIR}/111`, claudePid: 9911 })
    const list = await sessionsList(d)
    expect(list.kb.inline_keyboard.flat().some(b => 'callback_data' in b && b.callback_data === 'sm:owner')).toBe(false)
    for (const row of (list.kb as unknown as { inline_keyboard: { text: string }[][] }).inline_keyboard) {
      for (const b of row) expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(b.text)).toBe(false)
    }
    const sessionRows = list.kb.inline_keyboard.filter(row => row.some(b => 'callback_data' in b && b.callback_data.startsWith('sm:s:')))
    expect(sessionRows.length).toBeGreaterThan(0)
    for (const row of sessionRows) {
      expect(row).toHaveLength(1)
      expect(row[0]!.text).toMatch(/ (💤|⚙️|🔐)$/u)
      expect([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(row[0]!.text)].length).toBeLessThanOrEqual(28)
    }
    expect(sessionRows.some(row => (row[0] as { icon_custom_emoji_id?: string }).icon_custom_emoji_id === '5256261335682941418')).toBe(true)
    const { screenToRich } = await import('../src/rich.ts')
    const agentEmoji = '<tg-emoji emoji-id="5256261335682941418">🤖</tg-emoji>'
    expect(list.text).toContain(agentEmoji)
    expect(screenToRich(list.text)).toContain(agentEmoji)
    u.close()
    tg.push(textMessage({ from: 111, text: 'кто я' }))
    await Bun.sleep(200)
    expect(d.userLabel('111')).toBe('Den (@den, 111)')
    main = new FakeClient()
    await main.connect({ cwd: mainDir, projectRoot: null, claudePid: 779 })
    await main.inbound(x => x.meta.event === 'session_resume')
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

      // FR-9: voice forbidden by the recipient's privacy — the text goes, the chat hears why once, voice is off for it.
      tg.failures.set('sendVoice', { code: 400, description: 'Bad Request: VOICE_MESSAGES_FORBIDDEN' })
      const vr = await client.call('reply', { text: 'ответ при запрете голоса', voice: true })
      expect(vr.ok).toBe(true)
      await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('🔇 Telegram не даёт боту присылать вам голосовые') && JSON.stringify(c.body.reply_markup).includes(`vf:retry:${group}`))
      await tg.waitForAnswer('ответ при запрете голоса')
      expect(d.store.get(`voice_forbidden:${group}`)).toBe('1')
      tg.failures.delete('sendVoice')
      tg.push(callbackQuery(`vf:retry:${group}`, { chat: Number(group) }))
      await tg.waitFor('answerCallbackQuery', c => String(c.body.text).startsWith('🔁'))
      expect(d.store.get(`voice_forbidden:${group}`)).toBeNull()

      // A text message: back to text answers.
      tg.push(textMessage({ chat: Number(group), thread, text: 'а теперь текстом' }))
      await client.inbound(x => x.content === 'а теперь текстом')
      const voices = tg.callsOf('sendVoice').length
      await client.call('reply', { text: 'текстовый ответ' })
      await tg.waitForAnswer('текстовый ответ')
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
    const r = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('🖥 <b>') && !String(c.body.text).startsWith('🖥 <b>Экран'), 6000)
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
  test('FR-11: with rich screens a screen goes as a rich message — heading, divider, sections; HTML when Telegram refuses', async () => {
    process.env.RICH_SCREENS = 'on'
    try {
      tg.push(textMessage({ text: '/menu' }))
      const m = await tg.waitFor('sendRichMessage', c => String((c.body.rich_message as { html?: string } | undefined)?.html ?? '').startsWith('<h3>🎛 Меню</h3><hr/>'))
      expect(JSON.stringify(m.body.reply_markup)).toContain('hub:stats')
      expect(m.body.text).toBeUndefined()
      tg.push(callbackQuery('hub:help'))
      await tg.waitFor('editMessageText', c => String((c.body.rich_message as { html?: string } | undefined)?.html ?? '').startsWith('<h3>❓ Помощь</h3><hr/>'), 6000)
      // Refused: the same screen as HTML.
      tg.failures.set('sendRichMessage', { code: 400, description: 'Bad Request: RICH_MESSAGE_HTML_INVALID' })
      tg.push(textMessage({ text: '/menu' }))
      await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('🎛 <b>Меню</b>'))
    } finally {
      tg.failures.delete('sendRichMessage')
      process.env.RICH_SCREENS = 'off'
    }
  }, 15_000)

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
      // Codex: the hooks of the bridge are trusted; its input line (› without a number) is not the focus.
      const hooks = '› Ask Codex to do anything\n  Hooks need review\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting'
      expect(confirmKey(hooks)).toBe('Down')
      expect(confirmKey(hooks.replace('› 1.', '  1.').replace('  2. Trust', '› 2. Trust'))).toBe('Enter')
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

      // An own session's window (claude-user-…) works the same: screen, then confirm.
      client!.close()
      await Bun.sleep(100)
      client = null
      screen = channels
      tg.push(callbackQuery('tx:sclaude-user-555.0'))
      await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('🖥 <b>Экран</b> <code>claude-user-555:0</code>') && JSON.stringify(c.body.reply_markup).includes('tx:sclaude-user-555.0:c'))
      tg.push(callbackQuery('tx:sclaude-user-555.0:c', { messageId: 92 }))
      await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('✅ Сессия #') && c.body.message_id === 92, 5000)
      expect(pressed.at(-1)).toBe('=claude-user-555:0 Enter')

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

  test('⏳ a launch that never connected: the owner is reminded with the screen, the user hears once; a startup question is not reminded of', async () => {
    const { remindLaunch } = await import('../src/daemon/launch.ts')
    const dir = join(settings.usersDir, '555')
    // A startup question is answered by the question watch: no reminder for it.
    d.tmuxCapture = async t => (t === 'claude:9' ? 'WARNING: Loading development channels\n❯ 1. I am using this for local development\n  2. Exit' : null)
    const quietBefore = tg.callsOf('sendMessage').length
    await remindLaunch(d, dir, '9', true)
    expect(tg.callsOf('sendMessage').length).toBe(quietBefore)
    d.tmuxCapture = async t => (t === 'claude:9' ? 'Error: something broke\n$ ' : null)
    await remindLaunch(d, dir, '9', true)
    const owner = await tg.waitFor('sendMessage', c => c.body.chat_id === '111' && String(c.body.text).includes('(окно claude:9) запущена, но так и не подключилась'))
    expect(JSON.stringify(owner.body.reply_markup)).toContain('tx:w9')
    await tg.waitFor('sendMessage', c => c.body.chat_id === '555' && String(c.body.text).startsWith('⏳ Ваша сессия ещё запускается'))
    // The second reminder goes to the owner only; a gone window is not reported.
    const before = tg.callsOf('sendMessage').length
    await remindLaunch(d, dir, '9', false)
    expect(tg.callsOf('sendMessage').slice(before).map(c => c.body.chat_id)).toEqual(['111'])
    await remindLaunch(d, dir, '8', true)
    expect(tg.callsOf('sendMessage').length).toBe(before + 1)

    // 🔕: the other reminder goes, this one says «off», and no more come; 🔔 brings them back.
    const off = /lr:off:([0-9a-f]{10})/.exec(JSON.stringify(owner.body.reply_markup))![1]
    const deletes = tg.callsOf('deleteMessage').length
    tg.push(callbackQuery(`lr:off:${off}`, { messageId: 1 }))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('🔕 Напоминания о запуске'))
    await tg.waitFor('deleteMessage', () => tg.callsOf('deleteMessage').length > deletes)
    const quiet = tg.callsOf('sendMessage').length
    await remindLaunch(d, dir, '9', false)
    expect(tg.callsOf('sendMessage').length).toBe(quiet)
    tg.push(callbackQuery(`lr:on:${off}`))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('🔔 Напоминания о запуске'))
    await remindLaunch(d, dir, '9', false)
    expect(tg.callsOf('sendMessage').length).toBe(quiet + 1)
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
      tg.push(callbackQuery(`sm:g:${s.id}:c`))
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
    tg.push(callbackQuery(`sm:g:${sessionId}:m`))
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
      for (const cb of ['hub:tv:baya', 'hub:ts:125', 'hub:advanced']) expect(kb).toContain(cb)
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
      await tg.waitFor('editMessageText', x => String(x.body.chat_id) === g1 && x.body.text === 'ответ в группу')

      // Permission requests of a group's project go to the owner only, never to the group.
      c.sock.write(encode({ t: 'perm_req', request_id: 'mnopq', tool_name: 'Bash', description: 'ls', input_preview: '{}' }))
      await tg.waitFor('sendMessage', x => x.body.chat_id === '111' && String(x.body.text).startsWith('🔐 Test Group: Bash'))
      expect(tg.callsOf('sendMessage').some(x => String(x.body.chat_id) === g1 && String(x.body.text).startsWith('🔐'))).toBe(false)

      // The card shows the group; unbinding (in ⚙️) asks first.
      tg.push(callbackQuery(`sm:g:${s.id}:m`))
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

    // 🚫 Not a project: what waited goes to its author's own session, and so does what comes next.
    tg.push(textMessage({ chat: Number(g2), text: 'в личную' }))
    await tg.waitFor('sendMessage', x => x.body.chat_id === '111' && String(x.body.text).includes(`<code>${g2}</code>`))
    tg.push(callbackQuery(`gp:none:${g2}`))
    await tg.waitFor('editMessageText', x => String(x.body.text).includes('не проект'))
    expect(groupBinding(d, g2)).toEqual({ dir: null, title: 'Test Group' })
    await main.inbound(x => x.content === 'в личную')
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
    const { scheduleWarmup, setRunWarmup, warmupOn, fireWarmup, windowKey } = await import('../src/daemon/usage.ts')
    let runs = 0
    setRunWarmup(async () => { runs++ })
    expect(warmupOn(d)).toBe(false)
    tg.push(callbackQuery('us:r'))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === '📊 Собираю…')
    tg.push(callbackQuery('us:w:on'))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === '⚡ Окно будет запускаться сразу после сброса')
    expect(warmupOn(d)).toBe(true)
    // resets_at jitters between API calls by a fraction of a second: still one window, one run.
    // Away from the :30 rounding edge, so the jitter stays in one minute.
    let base = Date.now() - 59_000
    if (Math.abs((base % 60_000) - 30_000) < 1_000) base += 1_500
    const at = new Date(base - 300)
    scheduleWarmup(d, at)
    scheduleWarmup(d, new Date(base + 200))
    scheduleWarmup(d, new Date(base - 100))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('⚡ Новое окно «5 часов» запущено'), 4_000)
    await Bun.sleep(300)
    expect(runs).toBe(1)
    await fireWarmup(d, windowKey(at))
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

describe('journal (JOURNAL_CHAT_ID)', () => {
  test('notices go to the journal group; strangers and membership changes are logged there', async () => {
    const { warnOwner } = { warnOwner: (t: string) => d.warnOwner(t) }
    process.env.JOURNAL_CHAT_ID = '-5300'
    try {
      // A daemon notice: to the journal, not the owner's DM.
      ;(d as unknown as { lastWarn: number }).lastWarn = 0
      warnOwner('⚠️ проверка журнала')
      const w = await tg.waitFor('sendMessage', c => c.body.text === '⚠️ проверка журнала')
      expect(String(w.body.chat_id)).toBe('-5300')
      // Each kind in its own topic, created on first use.
      const daemonTopic = await tg.waitFor('createForumTopic', c => String(c.body.chat_id) === '-5300' && c.body.name === '⚙️ Демон')
      void daemonTopic
      expect(w.body.message_thread_id).toBeDefined()

      // The pinned dashboard moves from General of the topics group to the journal's «📌 Статус».
      const { updateDashboard } = await import('../src/daemon/topics.ts')
      const old = JSON.parse(d.store.get('dashboard_msg') ?? 'null') ?? { id: Number(d.store.get('dashboard_msg_id')) }
      await updateDashboard(d)
      const dash = await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '-5300' && String(c.body.text).includes('Пульт'))
      expect(dash.body.message_thread_id).toBeDefined()
      await tg.waitFor('createForumTopic', c => String(c.body.chat_id) === '-5300' && c.body.name === '📌 Статус')
      if (old.id) await tg.waitFor('deleteMessage', c => c.body.message_id === old.id)
      await tg.waitFor('pinChatMessage', c => String(c.body.chat_id) === '-5300')
      // Next time it is edited in place there.
      const edits = tg.callsOf('editMessageText').length
      ;(d.sessions.values().next().value as { lastActivity: number }).lastActivity = Date.now() - 3_600_000
      await updateDashboard(d)
      expect(tg.callsOf('editMessageText').slice(edits).some(c => String(c.body.chat_id) === '-5300')).toBe(true)

      // Someone who is not a user writes in a DM.
      tg.push(textMessage({ from: 777001, text: 'привет, кто ты?' }))
      const st = await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '-5300' && String(c.body.text).startsWith('✉️ Написал(а) не пользователь'))
      expect(String(st.body.text)).toContain('777001')
      expect(String(st.body.text)).toContain('привет, кто ты?')
      await tg.waitFor('createForumTopic', c => String(c.body.chat_id) === '-5300' && c.body.name === '🛡 Доступ')
      expect(st.body.message_thread_id).not.toBe(w.body.message_thread_id)

      // The bot added to and removed from a group.
      const member = (status: string) => ({ user: { id: 1, is_bot: true, first_name: 'bot' }, status })
      const upd = (from: string, to: string) => ({ my_chat_member: { chat: { id: -5400, type: 'group', title: 'Чужая' }, from: { id: 111, is_bot: false, first_name: 'Owner' }, date: 0, old_chat_member: member(from), new_chat_member: member(to) } })
      tg.push(upd('left', 'member'))
      await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '-5300' && String(c.body.text).startsWith('➕ Бота добавили в группу «Чужая»'))
      tg.push(upd('member', 'kicked'))
      await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '-5300' && String(c.body.text).startsWith('➖ Бота исключили из группы «Чужая»'))

      // Topics switched on: the group becomes a supergroup with a new id, the journal follows.
      tg.push({ message: { message_id: 5, date: 0, chat: { id: -5300, type: 'group', title: 'Журнал' }, from: { id: 111, is_bot: false, first_name: 'Owner' }, migrate_to_chat_id: -1005300 } })
      await Bun.sleep(200)
      ;(d as unknown as { lastWarn: number }).lastWarn = 0
      warnOwner('⚠️ после переезда')
      const moved = await tg.waitFor('sendMessage', c => c.body.text === '⚠️ после переезда')
      expect(String(moved.body.chat_id)).toBe('-1005300')
    } finally {
      delete process.env.JOURNAL_CHAT_ID
    }
  })
})

describe('session types', () => {
  const group = '-100500'
  const usersDir = process.env.USERS_DIR!
  const calls: { dir: string; o?: Record<string, unknown> }[] = []
  let u: FakeClient

  beforeAll(async () => {
    process.env.TOPIC_NO_SESSION = 'launch'
    d.launchSession = async (dir, o) => { calls.push({ dir, o }); return '7' }
    // The owner's session (the «main» fixture) is off: these tests start it themselves.
    main.close()
    await Bun.sleep(200)
  })
  afterAll(() => {
    process.env.TOPIC_NO_SESSION = 'queue'
    process.env.WATCHDOG_GRACE_SEC = '3600'
  })

  test('a DM without a user session launches it in USERS_DIR/<id>; the message arrives on connect', async () => {
    const earlier = new Set(tg.callsOf('sendMessage'))
    tg.push(textMessage({ text: 'привет, это я' }))
    const launchMsg = await tg.waitFor('sendMessage', c => !earlier.has(c) && String(c.body.text).startsWith('🚀 Запускаю вашу сессию'))
    // Nothing to confirm: the daemon answers the startup questions itself.
    expect(launchMsg.body.reply_markup).toBeUndefined()
    expect(calls.at(-1)!.dir).toBe(`${usersDir}/111`)
    expect(calls.at(-1)!.o?.name).toBe('claude-user-111')
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
    const sent = await tg.waitForAnswer('ответ в general')
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

  test('a member\'s stopped session: no commands for them, 🙋 asks the owner, who gets the commands and 🚀', async () => {
    process.env.WATCHDOG_GRACE_SEC = '0'
    const m = new FakeClient()
    await m.connect({ cwd: `${usersDir}/333`, projectRoot: `${usersDir}/333`, claudePid: 4444 })
    m.close()
    const mine = await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '333' && String(c.body.text).startsWith('⚠️ Ваша сессия остановилась'))
    expect(String(mine.body.text)).not.toContain('<pre>')
    expect(JSON.stringify(mine.body.reply_markup)).not.toContain('wd:run')
    const own = await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '111' && String(c.body.text).includes('остановилась') && String(c.body.text).includes('claude-user-333'))
    expect(JSON.stringify(own.body.reply_markup)).toContain('wd:run')
    const id = /wd:ask:([0-9a-f]+)/.exec(JSON.stringify(mine.body.reply_markup))![1]
    tg.push(callbackQuery(`wd:run:${id}`, { from: 333, chat: 333 }))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Нет доступа.')
    tg.push(callbackQuery(`wd:ask:${id}`, { from: 333, chat: 333 }))
    const ask = await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '111' && String(c.body.text).startsWith('🙋 '))
    expect(String(ask.body.text)).toContain('просит перезапустить')
    expect(JSON.stringify(ask.body.reply_markup)).toContain(`wd:run:${id}`)
    await tg.waitFor('editMessageText', c => String(c.body.text).includes('Запрос на перезапуск отправлен'))
  })

  test('old stopped notices are announced again the new way; they go when the session is back', async () => {
    const { renotifyStopped } = await import('../src/daemon/watchdog.ts')
    for (const k of d.store.keys('wd:')) d.store.set(k, null)
    d.store.set('wd:0ldc0de1', JSON.stringify({ dir: `${usersDir}/333`, resume: null, name: '👤 333', session: 'claude-333' }))
    d.store.set('wd:0ldc0de2', JSON.stringify({ dir: '/tmp/back', resume: null, name: '📂 back' }))
    const b = new FakeClient()
    await b.connect({ cwd: '/tmp/back', projectRoot: '/tmp/back', claudePid: 5555 })
    await renotifyStopped(d)
    expect(d.store.get('wd:0ldc0de2')).toBeNull()
    const mine = await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '333' && JSON.stringify(c.body.reply_markup ?? '').includes('wd:ask:0ldc0de1'))
    expect(String(mine.body.text)).not.toContain('<pre>')
    const own = await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '111' && JSON.stringify(c.body.reply_markup ?? '').includes('wd:run:0ldc0de1'))
    expect(String(own.body.text)).toContain('-n claude-user-333')
    expect(JSON.parse(d.store.get('wd:0ldc0de1')!).v).toBe(2)
    await renotifyStopped(d)
    expect(tg.callsOf('sendMessage').filter(c => JSON.stringify(c.body.reply_markup ?? '').includes('0ldc0de1')).length).toBe(2)

    const deletes = tg.callsOf('deleteMessage').length
    const m = new FakeClient()
    await m.connect({ cwd: `${usersDir}/333`, projectRoot: `${usersDir}/333`, claudePid: 6666 })
    await tg.waitFor('deleteMessage', () => tg.callsOf('deleteMessage').length >= deletes + 2)
    expect(d.store.get('wd:0ldc0de1')).toBeNull()
    m.close(); b.close()
  })

  test('💤 suspension: presets per kind in /menu; a suspension is told only to the journal', async () => {
    const { idleMin } = await import('../src/daemon/idle.ts')
    const { logSuspended, markIdle, idleRecord } = await import('../src/daemon/autoresume.ts')
    for (const k of ['user', 'owner', 'project']) d.store.set(`idle:${k}`, null)
    // The owner's own session: a week by default; the others from .env (0 here).
    expect(idleMin(d, 'owner')).toBe(10080)
    expect(idleMin(d, 'user')).toBe(0)
    tg.push(callbackQuery('hub:idle'))
    const sc = await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('💤 <b>Приостановка сессий</b>'))
    const rows = (sc.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard
    expect(rows.slice(0, 3).map(r => r.length)).toEqual([5, 5, 5])
    expect(rows[1].find(b => b.text.startsWith('•'))!.callback_data).toBe('ix:owner:4')
    tg.push(callbackQuery('ix:user:2'))
    await tg.waitFor('editMessageText', c => JSON.stringify(c.body.reply_markup ?? '').includes('"• сутки","callback_data":"ix:user:2"'))
    expect(idleMin(d, 'user')).toBe(1440)
    tg.push(callbackQuery('ix:project:1', { from: 333 }))
    await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Нет доступа.')

    const m = new FakeClient()
    await m.connect({ cwd: `${usersDir}/333`, projectRoot: `${usersDir}/333`, claudePid: 7777 })
    const s = [...d.sessions.values()].find(x => x.claudePid === 7777)!
    const sent = tg.callsOf('sendMessage').length
    markIdle(d, s, 'сутки')
    expect(idleRecord(d, s.cwd)).toMatchObject({ engine: 'claude', period: 'сутки', id: s.id })
    await logSuspended(d, s, 'сутки')
    const own = await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '111' && String(c.body.text).includes('приостановлена: сутки без дела. Следующее сообщение поднимет её само'))
    expect(own.body.reply_markup).toBeUndefined()
    // The member hears nothing: the next message wakes the session up.
    expect(tg.callsOf('sendMessage').slice(sent).some(c => String(c.body.chat_id) === '333')).toBe(false)
    d.store.set(`idle_suspended:${s.cwd}`, null)
    m.close()
    d.store.set('idle:user', null)
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
    expect(calls.at(-1)).toEqual({ dir: '/tmp/other', o: { name: 'claude-project-other' } })

    d.launching.clear()
    const ok = d.launchSession
    d.launchSession = async () => { throw new Error('no tmux') }
    tg.push(textMessage({ chat: Number(group), text: 'ещё раз', thread }))
    const failed = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('❌ Не удалось запустить сессию проекта') && c.body.message_thread_id === thread)
    // The topic is seen by everyone: the command goes to the owner's DM only.
    expect(String(failed.body.text)).not.toContain('<pre>')
    const cmd = await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '111' && String(c.body.text).startsWith('❌ Не удалось запустить сессию проекта <code>/tmp/other</code>'))
    expect(String(cmd.body.text)).toContain(`cd /tmp/other &amp;&amp; ${settings.launchCmd} -n claude-project-other</pre>`)
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
    const inTopic = await tg.waitFor('sendMessage', c => String(c.body.text).includes('остановилась') && c.body.message_thread_id === thread)
    expect(String(inTopic.body.text)).not.toContain(settings.launchCmd)
    expect(inTopic.body.reply_markup).toBeUndefined()
    const notice = await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '111' && String(c.body.text).includes('📂 other') && String(c.body.text).includes('остановилась'))
    expect(String(notice.body.text)).toContain(`${settings.launchCmd} -n claude-project-other --continue`)
    await tg.waitFor('closeForumTopic', () => tg.callsOf('closeForumTopic').length > closes)
    expect(d.store.topic(group, thread)?.status).toBe('waiting')
    const id = /wd:run:([0-9a-f]+)/.exec(JSON.stringify(notice.body.reply_markup))![1]
    tg.push(callbackQuery(`wd:run:${id}`, { chat: Number(group) }))
    await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('🚀 Запускаю'))
    // The stopped session's own engine: its conversation id is that CLI's.
    expect(calls.at(-1)).toEqual({ dir: '/tmp/other', o: { engine: 'claude', resume: undefined, continue: true, name: 'claude-project-other' } })
  })

  test('💤 idle wake-up: a suspended project session wakes up on the next topic message with its conversation; only the journal hears of it', async () => {
    const { mkdirSync } = await import('fs')
    const { markIdle, logSuspended, idleRecord } = await import('../src/daemon/autoresume.ts')
    const { connectTiming } = await import('../src/daemon/launch.ts')
    mkdirSync('/tmp/sleepy', { recursive: true })
    const saved = { capture: d.tmuxCapture, poll: connectTiming.pollMs }
    connectTiming.pollMs = 20
    d.tmuxCapture = async () => '  claude starting…'
    try {
      const p = new FakeClient()
      await p.connect({ cwd: '/tmp/sleepy', projectRoot: '/tmp/sleepy', claudePid: 7171, tmuxPane: '%71' })
      await tg.waitFor('createForumTopic', c => c.body.name === 'sleepy')
      const s = [...d.sessions.values()].find(x => x.claudePid === 7171)!
      for (let i = 0; i < 100 && !s.topic; i++) await Bun.sleep(20)
      const thread = s.topic!.threadId
      s.claude.sessionId = 'sess-sleepy-1'
      // The idle closer: marked, ended on purpose, the journal told.
      markIdle(d, s, 'сутки')
      d.ending.add(s.id)
      const mark = tg.calls.length
      p.close()
      await logSuspended(d, s, 'сутки')
      await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '111' && String(c.body.text).includes('📂 sleepy') && String(c.body.text).includes('приостановлена: сутки'))
      await Bun.sleep(200)
      // Nothing in the topic: no «⚪️ Сессия отключена», no «💤».
      expect(tg.calls.slice(mark).some(c => c.method === 'sendMessage' && c.body.message_thread_id === thread)).toBe(false)

      d.launching.clear()
      const before = tg.calls.length
      tg.push(textMessage({ chat: Number(group), text: 'проснись', thread }))
      await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '111' && String(c.body.text).startsWith('🔄 Сессия <b>📂 sleepy</b> поднимается сама'))
      expect(calls.at(-1)).toEqual({ dir: '/tmp/sleepy', o: { name: 'claude-project-sleepy', resume: 'sess-sleepy-1' } })
      const p2 = new FakeClient()
      await p2.connect({ cwd: '/tmp/sleepy', projectRoot: '/tmp/sleepy', claudePid: 7172, tmuxPane: '%72' })
      const resume = await p2.inbound(x => x.meta.event === 'session_resume')
      expect(resume.content).toContain('проснись')
      await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '111' && String(c.body.text).includes('снова в работе'))
      // The chat heard nothing but the answer's own progress: no «🚀 Запускаю», no «🟢 Сессия подключена».
      expect(tg.calls.slice(before).filter(c => c.method === 'sendMessage' && c.body.message_thread_id === thread).map(c => String(c.body.text)).filter(t => !t.startsWith('⏳ Работаю'))).toEqual([])
      expect(idleRecord(d, '/tmp/sleepy')).toBeNull()
      p2.close()
    } finally {
      d.tmuxCapture = saved.capture
      connectTiming.pollMs = saved.poll
    }
  })

  test('♻️ engine switch from 🧠: closed, its window closed, started as codex-project-… fresh, with the handoff (.telegram/handoff.md + first message); the menu follows each step', async () => {
    const { mkdirSync } = await import('fs')
    const { setProjectEngine } = await import('../src/daemon/engines.ts')
    const { connectTiming, endTiming } = await import('../src/daemon/launch.ts')
    mkdirSync('/tmp/sw', { recursive: true })
    const saved = { capture: d.tmuxCapture, type: d.tmuxType, keys: d.tmuxKeys, pane: d.tmuxPaneId, poll: connectTiming.pollMs, ms: endTiming.checkMs }
    connectTiming.pollMs = 20
    const p = new FakeClient()
    try {
      await p.connect({ cwd: '/tmp/sw', projectRoot: '/tmp/sw', claudePid: 8181, tmuxPane: '%81' })
      const s = [...d.sessions.values()].find(x => x.claudePid === 8181)!
      const typed: string[] = []
      d.tmuxCapture = async () => '❯ \n› '
      d.tmuxKeys = async () => {}
      d.tmuxType = async (_t, text) => { typed.push(text); if (text === '/exit') p.close() }
      d.tmuxPaneId = async () => null
      setProjectEngine(d, '/tmp/sw', { engine: 'codex' })
      d.store.set('last_conv:codex:/tmp/sw', 'thr-sw-1')
      tg.push(callbackQuery(`sm:mdl:${s.id}`))
      const sc = await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('🧠 <b>Движок и модель</b>') && String(c.body.text).includes(`#${s.id}`))
      expect(JSON.stringify(sc.body.reply_markup)).toContain(`Переключить на Codex сейчас","callback_data":"sm:engre:${s.id}"`)
      tg.push(callbackQuery(`sm:engre:${s.id}`))
      await tg.waitFor('answerCallbackQuery', c => c.body.text === '♻️ Перезапускаю')
      await tg.waitFor('editMessageText', c => String(c.body.text).startsWith('🚀 Запускаю Codex в tmux'))
      // Another engine starts fresh: its own old thread (thr-sw-1) would be stale next to the handoff.
      expect(calls.at(-1)).toEqual({ dir: '/tmp/sw', o: { name: 'codex-project-sw' } })
      const { readFileSync } = await import('fs')
      expect(readFileSync('/tmp/sw/.telegram/handoff.md', 'utf8')).toStartWith('# Передача дел: Claude Code → Codex')
      const q = new FakeClient()
      await q.connect({ cwd: '/tmp/sw', projectRoot: '/tmp/sw', claudePid: 8182, tmuxPane: '%82', engine: 'codex' })
      const done = await tg.waitFor('editMessageText', c => String(c.body.text).includes('работает на <b>Codex</b>'))
      expect(String(done.body.text)).toContain('дела переданы')
      // The first message to Codex: the handoff, pointing to the file.
      const deadline = Date.now() + 3000
      while (!typed.some(x => x.includes('[Передача дел')) && Date.now() < deadline) await Bun.sleep(20)
      const first = typed.find(x => x.includes('[Передача дел'))!
      expect(first).toContain('event="handoff"')
      expect(first).toContain('/tmp/sw/.telegram/handoff.md')
      q.close()
    } finally {
      Object.assign(d, { tmuxCapture: saved.capture, tmuxType: saved.type, tmuxKeys: saved.keys, tmuxPaneId: saved.pane })
      connectTiming.pollMs = saved.poll
      endTiming.checkMs = saved.ms
    }
  })

  test('Codex asks in its window: a card with buttons goes to the chat once; ♾ moves the selection and presses Enter', async () => {
    const { checkCodexApproval } = await import('../src/daemon/codexapproval.ts')
    const saved = { capture: d.tmuxCapture, keys: d.tmuxKeys }
    const q = new FakeClient()
    try {
      await q.connect({ cwd: '/tmp/cxa', projectRoot: '/tmp/cxa', claudePid: 8191, tmuxPane: '%91', engine: 'codex' })
      const s = [...d.sessions.values()].find(x => x.claudePid === 8191)!
      s.lastChat = { chatId: '111', isPrivate: true }
      let screen = ['  Would you like to run the following command?', '', '  $ rm -rf build', '', '› 1. Yes, just this once (y)', "  2. Yes, and don't ask again for this command in this session (a)", '  3. No, and tell Codex what to do differently (esc)'].join('\n')
      const keys: string[][] = []
      d.tmuxCapture = async () => screen
      d.tmuxKeys = async (_t, k) => { keys.push(k) }
      expect(await checkCodexApproval(d, s)).toBe(true)
      const card = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith(`🔐 Codex (#${s.id}) просит запустить команду:`))
      expect(String(card.body.text)).toContain('$ rm -rf build')
      expect(JSON.stringify(card.body.reply_markup)).toContain(`"callback_data":"cxa:a:${s.id}"`)
      // The same request is not sent twice.
      const n = tg.callsOf('sendMessage').length
      await checkCodexApproval(d, s)
      expect(tg.callsOf('sendMessage').length).toBe(n)
      tg.push(callbackQuery(`cxa:a:${s.id}`))
      await tg.waitFor('answerCallbackQuery', c => c.body.text === '♾ Разрешено до конца сессии')
      expect(keys).toEqual([['Down', 'Enter']])
      // Closed meanwhile: nothing is pressed.
      screen = '› '
      tg.push(callbackQuery(`cxa:y:${s.id}`))
      await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Запрос уже закрыт.')
      expect(keys.length).toBe(1)
    } finally {
      Object.assign(d, { tmuxCapture: saved.capture, tmuxKeys: saved.keys })
      q.close()
    }
  })

  test('FR-18: out of Claude tokens → «🔀 Продолжить на Codex до сброса»; the tap hands the work and the held messages to Codex; at the reset — the way back', async () => {
    const { mkdirSync } = await import('fs')
    const { onLimitFailure, holdIfPaused, release, fallbackOf } = await import('../src/daemon/outoftokens.ts')
    const { projectEngine } = await import('../src/daemon/engines.ts')
    const { connectTiming } = await import('../src/daemon/launch.ts')
    mkdirSync('/tmp/fb', { recursive: true })
    const saved = { capture: d.tmuxCapture, type: d.tmuxType, keys: d.tmuxKeys, pane: d.tmuxPaneId, poll: connectTiming.pollMs }
    connectTiming.pollMs = 20
    const p = new FakeClient()
    const typed: string[] = []
    try {
      await p.connect({ cwd: '/tmp/fb', projectRoot: '/tmp/fb', claudePid: 8201, tmuxPane: '%92' })
      const s = [...d.sessions.values()].find(x => x.claudePid === 8201)!
      s.lastChat = { chatId: '111', isPrivate: true }
      d.tmuxCapture = async () => '❯ \n› '
      d.tmuxKeys = async () => {}
      d.tmuxType = async (_t, text) => { typed.push(text); if (text === '/exit') p.close() }
      d.tmuxPaneId = async () => null
      await onLimitFailure(d, s, '', "You've hit your usage limit · resets 11pm")
      const pause = await tg.waitFor('sendMessage', c => String(c.body.chat_id) === '111' && String(c.body.text).startsWith('⏸ Закончились токены подписки Claude.'))
      expect(JSON.stringify(pause.body.reply_markup)).toContain(`"🔀 Продолжить на Codex до сброса","callback_data":"tok:cx:${s.id}"`)
      expect(holdIfPaused(d, s, 'а это пока сделай', { chat_id: '111', message_id: '5', user: 'den', user_id: '111' }, { chatId: '111', isPrivate: true })).toBe(true)

      const mark = tg.calls.length
      const after = (c: { method: string }) => tg.calls.indexOf(c as never) >= mark
      tg.push(callbackQuery(`tok:cx:${s.id}`))
      await tg.waitFor('editMessageText', c => after(c) && String(c.body.text).startsWith('🚀 Запускаю Codex в tmux'))
      expect(projectEngine(d, '/tmp/fb').engine).toBe('codex')
      expect(fallbackOf(d, '/tmp/fb')?.engine).toBe('claude')
      const q = new FakeClient()
      await q.connect({ cwd: '/tmp/fb', projectRoot: '/tmp/fb', claudePid: 8202, tmuxPane: '%93', engine: 'codex' })
      await tg.waitFor('editMessageText', c => after(c) && String(c.body.text).includes('работает на <b>Codex</b>'))
      const deadline = Date.now() + 3000
      while (!typed.some(x => x.includes('а это пока сделай')) && Date.now() < deadline) await Bun.sleep(20)
      expect(typed.find(x => x.includes('[Передача дел'))).toContain('У Claude закончился лимит')
      expect(typed.some(x => x.includes('а это пока сделай'))).toBe(true)
      await tg.waitFor('sendMessage', c => String(c.body.text) === '🔀 Отвечает Codex — записанное (1).')

      // The reset: the pause goes, the project on Codex is offered the way back.
      await release(d)
      const offer = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('▶️ Лимит Claude восстановился. Сессия #'))
      expect(JSON.stringify(offer.body.reply_markup)).toContain('tok:back:')
      tg.push(callbackQuery(String(JSON.stringify(offer.body.reply_markup)).match(/tok:stay:[0-9a-f]+/)![0]))
      await tg.waitFor('answerCallbackQuery', c => c.body.text === 'Остаётся на Codex')
      expect(fallbackOf(d, '/tmp/fb')).toBeNull()
      q.close()
    } finally {
      Object.assign(d, { tmuxCapture: saved.capture, tmuxType: saved.type, tmuxKeys: saved.keys, tmuxPaneId: saved.pane })
      connectTiming.pollMs = saved.poll
      d.store.set('tokens_pause', null)
      d.store.set('engine:/tmp/fb', null)
    }
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

describe('attachments land in the session folder', () => {
  test('a photo to a project topic is saved to <cwd>/.telegram/inbox, git-ignored; download_attachment too', async () => {
    const { readFileSync } = await import('fs')
    const s = d.sessions.get(sessionId)!
    mkdirSync(s.cwd, { recursive: true })
    tg.files.set('photo1', Buffer.from('fake-jpeg'))
    tg.files.set('doc1', Buffer.from('%PDF-fake'))
    tg.push({ message: { message_id: 92001, date: Math.floor(Date.now() / 1000), from: { id: 111, is_bot: false, first_name: 'Den' },
      chat: { id: -100500, type: 'supergroup', title: 'Test Group', is_forum: true }, message_thread_id: s.topic!.threadId, is_topic_message: true,
      caption: 'проверь фото', photo: [{ file_id: 'photo1', file_unique_id: 'ph1', width: 10, height: 10 }] } })
    const m = await client.inbound(x => x.meta.message_id === '92001')
    const inbox = join(s.cwd, '.telegram', 'inbox')
    expect(m.meta.image_path.startsWith(inbox + '/')).toBe(true)
    expect(readFileSync(m.meta.image_path, 'utf8')).toBe('fake-jpeg')
    expect(readFileSync(join(s.cwd, '.telegram', '.gitignore'), 'utf8')).toBe('*\n')

    const r = await client.call('download_attachment', { file_id: 'doc1' })
    expect(r.ok).toBe(true)
    const path = r.text
    expect(path.startsWith(inbox + '/')).toBe(true)
    expect(existsSync(path)).toBe(true)
  })
})


describe('economy integration', () => {
  test('plain messages from one sender are delivered together; explicit reply copies without a model turn', async () => {
    const s = d.sessions.get(sessionId)!
    const chat = s.topic!.chatId
    const thread = s.topic!.threadId
    process.env.TEXT_BATCH_MS = '30'
    try {
      tg.push(textMessage({ chat: Number(chat), thread, text: 'economy first instruction' }))
      tg.push(textMessage({ chat: Number(chat), thread, text: 'economy second instruction' }))
      const merged = await client.inbound(m => m.meta.batch_count === '2')
      expect(merged.content).toContain('economy first instruction')
      expect(merged.content).toContain('economy second instruction')
      expect(merged.meta.user_role).toBe('owner')
      const before = client.msgs.filter(m => m.t === 'inbound').length
      const copies = tg.callsOf('copyMessage').length
      tg.push(textMessage({ chat: Number(chat), thread, text: 'пришли ещё раз', replyTo: { message_id: 1234, from: { id: 999, is_bot: true, first_name: 'Bot' }, text: 'report' } }))
      await tg.waitFor('copyMessage', c => c.body.message_id === 1234)
      expect(tg.callsOf('copyMessage').length).toBe(copies + 1)
      expect(client.msgs.filter(m => m.t === 'inbound').length).toBe(before)
    } finally { process.env.TEXT_BATCH_MS = '0' }
  })
  test('economy metrics and effort presets use no model and preserve engine/model', async () => {
    const s = d.sessions.get(sessionId)!
    const chat = s.topic!.chatId
    const thread = s.topic!.threadId
    const key = `effort:claude:${s.projectKey}`
    const old = d.store.get(key)
    const before = client.msgs.filter(m => m.t === 'inbound').length
    const oldModel = d.store.get(`engine:${s.projectKey}`)
    try {
      tg.push(textMessage({ chat: Number(chat), thread, text: '/economy fast' }))
      await tg.waitFor('sendMessage', c => String(c.body.text).includes('effort=low'))
      expect(d.store.get(key)).toBe('low')
      expect(d.store.get(`engine:${s.projectKey}`)).toBe(oldModel)
      tg.push(textMessage({ chat: Number(chat), thread, text: '/economy' }))
      await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('Economy · UTC'))
      expect(client.msgs.filter(m => m.t === 'inbound').length).toBe(before)
    } finally { d.store.set(key, old) }
  })
})

describe('stable UX controls', () => {
  test('an old destructive session button only opens the replacement card', async () => {
    const { handleSessionMenu } = await import('../src/daemon/menu.ts')
    const s = d.sessions.get(sessionId)!
    const old = 'faded123'
    d.store.set(`ux:alias:${old}`, JSON.stringify({ projectKey: s.projectKey, cwd: s.cwd, topic: s.topic }))
    const typed: string[] = []
    const saved = d.tmuxType
    const notices: string[] = []
    d.tmuxType = async (_p, text) => { typed.push(text) }
    try {
      const ctx = { from: { id: 111 }, answerCallbackQuery: async (p?: { text?: string }) => { notices.push(p?.text ?? '') }, editMessageText: async () => {} } as never
      expect(await handleSessionMenu(d, ctx, `sm:clrok:${old}`)).toBe(true)
      expect(typed).toHaveLength(0)
      expect(notices[0]).toContain('перезапущена')
    } finally { d.tmuxType = saved }
  })
})

describe('simple task UX', () => {
  test('a selected task survives a local status query, then applies to one real message', async () => {
    const s = d.sessions.get(sessionId)!
    const { selectTask, selectedTask } = await import('../src/daemon/tasks.ts')
    const chat = { chatId: s.topic!.chatId, threadId: s.topic!.threadId, isPrivate: false }
    selectTask(d, chat, '111', 'explain')
    tg.push(textMessage({ chat: Number(chat.chatId), thread: chat.threadId, text: 'ты жив?' }))
    await tg.waitFor('sendMessage', x => String(x.body.text).includes(`#${s.id}, активность`))
    expect(selectedTask(d, chat, '111')).toBe('explain')
    tg.push(textMessage({ chat: Number(chat.chatId), thread: chat.threadId, text: 'explain this task fixture' }))
    const m = await client.inbound(x => x.meta.task_kind === 'explain')
    expect(m.content).toContain('explain this task fixture')
    expect(selectedTask(d, chat, '111')).toBeNull()
  })
  test('answer detail is scoped to the chat and included in the next agent message', async () => {
    const { setPref } = await import('../src/access.ts')
    const s = d.sessions.get(sessionId)!
    const chatId = s.topic!.chatId, threadId = s.topic!.threadId
    setPref(`${chatId}:${threadId}`, { answerDetail: 'short' })
    try {
      tg.push(textMessage({ chat: Number(chatId), thread: threadId, text: 'answer detail fixture' }))
      const m = await client.inbound(x => x.content.includes('answer detail fixture'))
      expect(m.meta.answer_detail).toBe('short')
    } finally { setPref(`${chatId}:${threadId}`, { answerDetail: 'normal' }) }
  })
})


test('a bare photo without an active task asks once and the selected action routes the original photo', async () => {
  const s = d.sessions.get(sessionId)!
  s.status = 'idle'; s.turn = null
  const chat = s.topic!.chatId, thread = s.topic!.threadId
  tg.files.set('taskPhoto', Buffer.from('task-image'))
  tg.push({ message: { message_id: 99001, date: Math.floor(Date.now() / 1000), from: { id: 111, is_bot: false, first_name: 'Den' },
    chat: { id: Number(chat), type: 'supergroup', title: 'Test Group', is_forum: true }, message_thread_id: thread, is_topic_message: true,
    photo: [{ file_id: 'taskPhoto', file_unique_id: 'task-image', width: 10, height: 10 }] } })
  const q = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('Файл принят') && String(JSON.stringify(c.body.reply_markup)).includes('tk:file:') && (c.body.reply_parameters as { message_id?: number } | undefined)?.message_id === 99001)
  expect(client.msgs.some(m => m.t === 'inbound' && (m as Inbound).meta.message_id === '99001')).toBe(false)
  const id = /tk:file:([0-9a-f]+):check/.exec(JSON.stringify(q.body.reply_markup))![1]
  const tap = callbackQuery(`tk:file:${id}:check`, { chat: Number(chat) })
  const msg = (tap.callback_query as { message: Record<string, unknown> }).message
  msg.message_thread_id = thread; msg.is_topic_message = true
  tg.push(tap)
  const delivered = await client.inbound(m => m.meta.message_id === '99001')
  expect(delivered.meta.task_kind).toBe('check')
  expect(existsSync(delivered.meta.image_path)).toBe(true)
})
