/**
 * End-to-end: real daemon (in-process) + fake Bot API + a fake session client
 * over the unix socket. No real Telegram traffic.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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
    const progress = await tg.waitFor('sendMessage', c => c.body.text === '⏳ Работаю…')
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

  test('/topics shows a card per session with its tmux target, plus topics without a session', async () => {
    d.tmuxLocation = async p => (p === '%9' ? { session: 'work', window: '2', windowName: 'tmuxed', pane: '0', tail: '> \n  ? for shortcuts   /rc active\n' } : null)
    const t = new FakeClient()
    await t.connect({ cwd: '/tmp/tmuxed', projectRoot: '/tmp/tmuxed', tmuxPane: '%9', branch: 'feat', claudePid: 99 })
    await tg.waitFor('createForumTopic', c => c.body.name === 'tmuxed')
    tg.push(textMessage({ text: '/topics' }))
    const r = await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('📋 <b>Сессии и топики'))
    const text = String(r.body.text)
    expect(r.body.parse_mode).toBe('HTML')
    expect(text.indexOf('👑 <b>Главная</b>')).toBeLessThan(text.indexOf('📂 <b>proj</b>'))
    expect(text).toContain(`#${sessionId}`)
    expect(text).toContain('🖥 tmux: <b>work</b> · окно 2 «tmuxed» · панель 0')
    expect(text).toContain('tmux attach -t work:2')
    expect(text).toContain('⏹ Стоп: доступен')
    expect(text).toContain('📱 Remote Control: вкл (/rc active в терминале)')
    expect(text).toContain('📱 Remote Control: выкл')
    expect(text).toContain('🌿 <code>feat</code>')
    expect(text).toContain('🖥 не в tmux')
    expect(text).toContain('💤 <b>Без сессии</b>')
    expect(text).toContain('/tmp/other')
    expect(JSON.stringify(r.body.reply_markup)).toContain('tp:')
    t.close()
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
    const msg = await tg.waitFor('sendMessage', c => String(c.body.text).includes('🔐'))
    expect(msg.body.chat_id).toBe(group)
    tg.push(callbackQuery('perm:allow:abcde', { chat: Number(group) }))
    const v = await client.wait(m => m.t === 'perm')
    expect(v).toEqual({ t: 'perm', request_id: 'abcde', behavior: 'allow' })
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

    tg.push(callbackQuery(`ses:ar:${sess.id}`, { chat: Number(group) }))
    await tg.waitFor('sendMessage', c => String(c.body.text).startsWith('Архивировать «arch»'))
    tg.push(callbackQuery(`ses:arok:${sess.id}`, { chat: Number(group) }))
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
