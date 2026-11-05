import { test, expect, describe } from 'bun:test'
import { Store } from '../src/db.ts'
import { receiveMessage, deliveryPhase, sessionPhase, renderDelivery, rememberSession, replacementSession, publishResult, lastResult, handleUxCallback } from '../src/daemon/ux.ts'
import { verifyStop } from '../src/daemon/stopcheck.ts'
import type { Daemon, Session } from '../src/daemon/daemon.ts'
import type { Context } from 'grammy'

const chat = { chatId: '111', isPrivate: true }
function setup() {
  const calls: { method: string; args: unknown[] }[] = []
  let id = 1000
  const api = new Proxy({}, { get: (_, method: string) => async (...args: unknown[]) => { calls.push({ method, args }); return { message_id: id++, chat: { id: 111 } } } })
  const sessions = new Map<string, Session>()
  const d = { store: new Store(':memory:'), sessions, activeSessions: () => [...sessions.values()], userIdOf: () => '111', bot: { api }, log: () => {}, onSessionsChanged: () => {}, tmuxCapture: async () => '❯ ' } as unknown as Daemon
  const s = { id: 'a1234567', projectKey: '/project', cwd: '/project', engine: 'claude', status: 'working', tmuxPane: '%123', lastChat: chat, stoppedAt: null, turn: { start: 1, replied: false } } as Session
  d.sessions.set(s.id, s)
  return { d, s, calls }
}
function context(chatId = 111, thread?: number) {
  const replies: string[] = []
  return { replies, ctx: { from: { id: 111 }, callbackQuery: { message: { message_id: 100, chat: { id: chatId }, message_thread_id: thread } }, answerCallbackQuery: async () => {}, editMessageText: async (text: string) => { replies.push(text) }, reply: async (text: string) => { replies.push(text) } } as unknown as Context }
}
describe('reliable UX', () => {
  test('dispatch and agent activity are distinct; terminal delivery states do not regress', async () => {
    const { d, s, calls } = setup()
    receiveMessage(d, chat, '1', '111')
    const meta = { chat_id: '111', message_id: '1' }
    deliveryPhase(d, meta, 'sent', s)
    expect(JSON.parse(d.store.get('ux:delivery:111:1')!).phase).toBe('sent')
    sessionPhase(d, s, 'working')
    expect(JSON.parse(d.store.get('ux:delivery:111:1')!).phase).toBe('working')
    sessionPhase(d, s, 'done')
    deliveryPhase(d, meta, 'working', s)
    expect(JSON.parse(d.store.get('ux:delivery:111:1')!).phase).toBe('done')
    await renderDelivery(d, 'ux:delivery:111:1')
    expect(calls).toHaveLength(0)
  })
  test('active deliveries follow a reconnected session, without changing the stable project', () => {
    const { d, s } = setup()
    rememberSession(d, s)
    receiveMessage(d, chat, '2', '111')
    deliveryPhase(d, { chat_id: '111', message_id: '2' }, 'sent', s)
    d.sessions.delete(s.id)
    const n = { ...s, id: 'b1234567' }
    d.sessions.set(n.id, n)
    rememberSession(d, n)
    expect(replacementSession(d, s.id)?.id).toBe(n.id)
    expect(replacementSession(d, 'unknown')).toBeNull()
    sessionPhase(d, n, 'working')
    expect(JSON.parse(d.store.get('ux:delivery:111:2')!).phase).toBe('working')
    expect(d.store.get(`ux:active:${s.id}`)).toBeNull()
  })
  test('stop is only confirmed on an idle screen and cannot stop a newer turn', async () => {
    const { d, s } = setup()
    s.stoppedAt = 1; s.stopRequest = { at: 1, phase: 'sent' }
    d.tmuxCapture = async () => '❯ prompt\nesc to interrupt'
    expect(await verifyStop(d, s, 1)).toBe(false)
    expect(s.status).toBe('working')
    expect(s.stopRequest.phase).toBe('failed')
    s.stopRequest = { at: 1, phase: 'sent' }
    d.tmuxCapture = async () => '❯ '
    expect(await verifyStop(d, s, 1)).toBe(true)
    expect(s.status).toBe('idle')
    s.status = 'working'; s.stoppedAt = 2; s.stopRequest = { at: 2, phase: 'sent' }
    d.tmuxCapture = async () => { s.stoppedAt = null; return '❯ ' }
    expect(await verifyStop(d, s, 2)).toBe(false)
    expect(s.status).toBe('working')
  })
  test('multipart results and attachments replay from persistent records without model calls', async () => {
    const { d, s, calls } = setup()
    const old = process.env.RESULT_CARDS
    process.env.RESULT_CARDS = 'on'
    try {
      d.store.addMessage({ chat_id: '111', thread_id: null, message_id: 12, direction: 'out', from_id: '999', from_name: 'bot', date: 1, text: 'file', kind: 'document', file_id: null, reply_to: null, quote: null, forward: null })
      await publishResult(d, s, chat, [10, 11, 12], 'answer', { summary: 'Implemented', checks: '3 tests passed', remaining: 'Deploy', pr_url: 'https://github.com/a/b/pull/1' })
      const r = lastResult(d, s.projectKey)!
      expect(r.files).toEqual([12])
      expect(r.unread).toBe(true)
      const { ctx, replies } = context()
      await handleUxCallback(d, ctx, `urx:show:${r.id}`)
      expect(replies[0]).toContain('3 tests passed')
      await handleUxCallback(d, ctx, `urx:repeat:${r.id}`)
      expect(calls.filter(c => c.method === 'copyMessage').map(c => c.args[2])).toEqual([10, 11, 12])
      expect(lastResult(d, s.projectKey)?.unread).toBe(false)
      const before = calls.length
      await handleUxCallback(d, context(222).ctx, `urx:repeat:${r.id}`)
      expect(calls).toHaveLength(before)
      await handleUxCallback(d, context(111, 37).ctx, `urx:repeat:${r.id}`)
      expect(calls).toHaveLength(before)
    } finally { process.env.RESULT_CARDS = old }
  })
  test('receipt-card API completion cannot overwrite a newer phase', async () => {
    const { d, s } = setup()
    receiveMessage(d, chat, '3', '111')
    const meta = { chat_id: '111', message_id: '3' }
    ;(d.bot as unknown as { api: unknown }).api = { sendMessage: async () => { deliveryPhase(d, meta, 'working', s); return { message_id: 987 } } }
    await renderDelivery(d, 'ux:delivery:111:3')
    expect(JSON.parse(d.store.get('ux:delivery:111:3')!).phase).toBe('working')
    expect(JSON.parse(d.store.get('ux:delivery:111:3')!).card).toBe(987)
  })
})

test('owner and attention sessions come first, with no duplicate buttons', async () => {
  const { d, s } = setup()
  const { sessionsList } = await import('../src/daemon/menu.ts')
  Object.assign(s, { argv: [], claude: { sessionId: null, transcript: null }, projectName: 'Owner', passive: false, topic: null, group: null })
  const waiting = { ...s, id: 'a1111111', cwd: '/waiting', projectKey: '/waiting', projectName: 'Waiting', status: 'waiting', turn: null } as Session
  const idle = { ...s, id: 'a2222222', cwd: '/idle', projectKey: '/idle', projectName: 'Idle', status: 'idle', turn: null } as Session
  d.sessions.set(waiting.id, waiting); d.sessions.set(idle.id, idle)
  d.userIdOf = x => x.id === s.id ? '111' : null
  d.userSession = () => s
  d.userLabel = () => 'Owner'; d.userShortName = () => 'Owner'
  Object.assign(d, { permissions: new Map() })
  const list = await sessionsList(d)
  const buttons = list.kb.inline_keyboard.flat().filter(b => 'callback_data' in b && b.callback_data.startsWith('sm:s:')) as { callback_data: string }[]
  expect(buttons.map(b => b.callback_data)).toEqual([`sm:s:${s.id}`, `sm:s:${waiting.id}`, `sm:s:${idle.id}`])
  expect(list.text).toContain('Требуют внимания')
})

test('an old stop check cannot confirm a newer stop with the same timestamp', async () => {
  const { applySessionEvent } = await import('../src/core/session.ts')
  const { d, s } = setup()
  applySessionEvent(s,{type:'stop_requested',at:10})
  const first = s.stopRequest!.token
  let release!: (screen:string)=>void
  d.tmuxCapture = () => new Promise(resolve => {release = resolve})
  const checking = verifyStop(d,s,10,first)
  applySessionEvent(s,{type:'delivered',at:11})
  applySessionEvent(s,{type:'stop_requested',at:10})
  const second = s.stopRequest!.token
  release('❯ ')
  expect(await checking).toBe(false)
  expect(s.stopRequest).toMatchObject({at:10,token:second,phase:'sent'})
  expect(s.status).toBe('working')
  expect(await verifyStop(d,s,10,first)).toBe(false)
})

test('a failed old tmux interrupt cannot overwrite a new turn or send a stale failure notice', async () => {
  const { applySessionEvent } = await import('../src/core/session.ts')
  const { stopSession } = await import('../src/daemon/inbound.ts')
  const { d, s, calls } = setup()
  s.notes = []
  Object.assign(d,{streams:{close:()=>{}}})
  let reject!: (error:Error)=>void
  d.tmuxKeys = () => new Promise((_,fail)=>{reject = fail})
  stopSession(d,s,'button')
  applySessionEvent(s,{type:'delivered',at:Date.now()})
  reject(new Error('old interrupt failed'))
  await Promise.resolve(); await Promise.resolve()
  expect(s.stopRequest).toBeUndefined()
  expect(s.status).toBe('working')
  expect(calls.some(c=>c.method === 'sendMessage')).toBe(false)
})


test('an old Stop hook cannot replace a new conversation or mark it idle', async () => {
  const { handleHook } = await import('../src/daemon/http.ts')
  const {d,s} = setup()
  s.turn = {start:10,replied:false}; s.lastHookAt = 11
  s.claude = {sessionId:'current',transcript:'/current.jsonl',permissionMode:null}
  Object.assign(d,{sessionByClaudePid:()=>s})
  handleHook(d,{claudePid:1,event:'Stop',at:9,data:{session_id:'obsolete',transcript_path:'/obsolete.jsonl'}})
  expect(s.status).toBe('working')
  expect(s.turn?.start).toBe(10)
  expect(s.lastHookAt).toBe(11)
  expect(s.claude).toMatchObject({sessionId:'current',transcript:'/current.jsonl'})
})


test('a failed interrupt of a disconnected session cannot notify its replacement', async () => {
  const { stopSession } = await import('../src/daemon/inbound.ts')
  const { d, s, calls } = setup()
  s.notes = []
  Object.assign(d,{streams:{close:()=>{}}})
  let reject!: (error:Error)=>void
  d.tmuxKeys = () => new Promise((_,fail)=>{reject = fail})
  stopSession(d,s,'button')
  d.sessions.delete(s.id)
  reject(new Error('disconnected interrupt'))
  await Promise.resolve(); await Promise.resolve()
  expect(calls.some(c=>c.method === 'sendMessage')).toBe(false)
})
