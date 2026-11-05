import { describe, test, expect } from 'bun:test'
import { Store } from '../src/db.ts'
import { Bot } from 'grammy'
import { budgetHistory, boundedResult, queueTextBatch, flushTextBatch, restoreTextBatches, rememberContext, contextSeen, contextMemory, rememberMemory, activateContext, installEconomy, cancelTextBatch } from '../src/daemon/economy.ts'
import type { Daemon, Session } from '../src/daemon/daemon.ts'

function fixture() {
  const delivered: { text: string; meta: Record<string, string>; chat: unknown }[] = []
  const d = { store: new Store(':memory:'), botId: 999, log: () => {}, routeText: async (chat: unknown, _from: string, text: string, meta: Record<string, string>) => { delivered.push({ chat, text, meta }) } } as unknown as Daemon
  return { d, delivered }
}
const chat = { chatId: '111', isPrivate: true }
const session = (id: string | null, argv: string[] = []) => ({ cwd: '/test/economy', engine: 'claude', argv, claude: { sessionId: id } }) as Session

describe('token economy', () => {
  test('whole history entries stay inside budget, zero disables history, pending content is independent', () => {
    const rows = [{ text: 'old'.repeat(100) }, { text: 'new'.repeat(100) }]
    expect(budgetHistory(rows, 400)).toEqual([rows[1]!])
    expect(budgetHistory(rows, 0)).toEqual([])
    expect(boundedResult('x'.repeat(9000), 1000).length).toBe(1000)
    expect(boundedResult('x'.repeat(90), 20).length).toBe(20)
    expect(boundedResult('x'.repeat(90), 0).length).toBe(90)
    expect(boundedResult('hello', 100)).toBe('hello')
  })
  test('context receipts are isolated by conversation, engine, project and chat', () => {
    const { d } = fixture()
    const a = session('conversation-a')
    rememberContext(d, a, '111', ['1'])
    rememberMemory(d, a, 'decisions')
    expect(contextSeen(d, session(null, ['claude', '--resume', 'conversation-a']), '111', '1')).toBe(true)
    expect(contextSeen(d, session('conversation-b'), '111', '1')).toBe(false)
    expect(contextSeen(d, a, '222', '1')).toBe(false)
    expect(contextSeen(d, { ...a, engine: 'codex' }, '111', '1')).toBe(false)
    expect(contextSeen(d, { ...a, cwd: '/other' }, '111', '1')).toBe(false)
    expect(contextMemory(d, a, 'decisions')).toBeNull()
    expect(contextMemory(d, a, 'new decisions')).toBe('new decisions')
    expect(contextMemory(d, session(null), 'decisions')).toBe('decisions')
  })
  test('context sent before the first hook is attached when the actual conversation becomes known', () => {
    const { d } = fixture()
    const s = session(null)
    rememberContext(d, s, '111', ['12'])
    rememberMemory(d, s, 'goals')
    activateContext(d, s, 'known')
    expect(contextSeen(d, session('known'), '111', '12')).toBe(true)
    expect(contextMemory(d, session('known'), 'goals')).toBeNull()
  })
  test('durable batch groups one sender, keeps message metadata and does not cross threads', async () => {
    const { d, delivered } = fixture()
    const old = process.env.TEXT_BATCH_MS
    process.env.TEXT_BATCH_MS = '3000'
    try {
      queueTextBatch(d, chat, '111', 'first', { message_id: '1', user_role: 'owner', task_kind: 'review' })
      queueTextBatch(d, chat, '111', 'second', { message_id: '2', user_role: 'owner' })
      queueTextBatch(d, { ...chat, threadId: 37 }, '111', 'other', { message_id: '3' })
      await flushTextBatch(d, 'economy:batch:111:0:111')
      expect(delivered).toHaveLength(1)
      expect(delivered[0]!.text).toContain('first')
      expect(delivered[0]!.text).toContain('second')
      expect(delivered[0]!.text).not.toContain('other')
      expect(delivered[0]!.meta).toMatchObject({ message_ids: '1,2', user_role: 'owner', batch_count: '2', task_kind: 'review' })
      await flushTextBatch(d, 'economy:batch:111:37:111')
      expect(delivered).toHaveLength(2)
    } finally { process.env.TEXT_BATCH_MS = old }
  })
  test('restart recovers a saved batch and failed routing retains it for retry', async () => {
    const { d, delivered } = fixture()
    const key = 'economy:batch:111:0:111'
    d.store.set(key, JSON.stringify({ chat, from: '111', due: 0, items: [{ text: 'saved', meta: { message_id: '5' } }] }))
    const route = d.routeText
    d.routeText = async () => { throw new Error('offline') }
    await expect(flushTextBatch(d, key)).rejects.toThrow('offline')
    expect(d.store.get(key)).not.toBeNull()
    d.routeText = route
    restoreTextBatches(d)
    await Bun.sleep(30)
    expect(delivered).toHaveLength(1)
    expect(d.store.get(key)).toBeNull()
  })
  test('messages appended while routing are not removed with the first batch', async () => {
    const { d, delivered } = fixture()
    const key = 'economy:batch:111:0:111'
    d.store.set(key, JSON.stringify({ chat, from: '111', due: 0, items: [{ text: 'first', meta: { message_id: '1' } }] }))
    const route = d.routeText
    d.routeText = async (...args) => {
      d.store.set(key, JSON.stringify({ chat, from: '111', due: 0, items: [{ text: 'first', meta: { message_id: '1' } }, { text: 'second', meta: { message_id: '2' } }] }))
      d.routeText = route
      await route(...args)
    }
    await flushTextBatch(d, key)
    await Bun.sleep(30)
    expect(delivered.map(x => x.text)).toEqual(['first', 'second'])
  })
  test('stop cancels a queued request and guest messages are never silently queued/dropped', async () => {
    const { d, delivered } = fixture()
    const old = process.env.TEXT_BATCH_MS
    process.env.TEXT_BATCH_MS = '3000'
    try {
      expect(queueTextBatch(d, chat, '999999', 'guest', { message_id: '1' })).toBe(false)
      expect(queueTextBatch(d, chat, '111', 'cancel me', { message_id: '2' })).toBe(true)
      expect(cancelTextBatch(d, chat, '111')).toBe(true)
      await flushTextBatch(d, 'economy:batch:111:0:111')
      expect(delivered).toHaveLength(0)
    } finally { process.env.TEXT_BATCH_MS = old }
  })
  test('history cap is applied by the real tool handler, full get_message remains available', async () => {
    const { d } = fixture()
    const { handleCall } = await import('../src/daemon/tools.ts')
    d.userIdOf = () => '111'
    const s = { ...session('history'), passive: false, topic: null, group: null, lastChat: chat } as Session
    d.store.addMessage({ chat_id: '111', thread_id: null, message_id: 1, direction: 'in', from_id: '111', from_name: 'test', date: 1, text: 'z'.repeat(10000), kind: 'text', file_id: null, reply_to: null, quote: null, forward: null })
    const short = await handleCall(d, s, 'get_history', { chat_id: '111' })
    expect(short.length).toBe(6000)
    expect(short).toContain('get_message')
    const full = JSON.parse(await handleCall(d, s, 'get_message', { chat_id: '111', message_id: 1 }))
    expect(full.text.length).toBe(10000)
  })
  test('preparing resume context does not consume pending tasks', () => {
    const { d } = fixture()
    d.store.addPending('project', 'important task', { message_id: '5' })
    expect(d.store.peekPending('project', 72)).toHaveLength(1)
    expect(d.store.peekPending('project', 72)).toHaveLength(1)
    expect(d.store.takePending('project', 72)).toHaveLength(1)
    expect(d.store.peekPending('project', 72)).toHaveLength(0)
  })
  test('successful update receipts survive middleware recreation, failures remain retryable', async () => {
    const { d } = fixture()
    const bot = new Bot('123:TEST', { botInfo: { id: 999, is_bot: true, first_name: 'Test', username: 'testbot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false } })
    installEconomy(d, bot)
    let calls = 0
    let fail = true
    bot.on('message', () => { calls++; if (fail) throw new Error('retry') })
    const update = { update_id: 101, message: { message_id: 1, date: 0, text: 'hello', from: { id: 111, is_bot: false, first_name: 'Test' }, chat: { id: 111, type: 'private' as const, first_name: 'Test' } } }
    await expect(bot.handleUpdate(update)).rejects.toThrow()
    fail = false
    await bot.handleUpdate(update)
    await bot.handleUpdate(update)
    expect(calls).toBe(2)
    const next = new Bot('123:TEST', { botInfo: bot.botInfo })
    installEconomy(d, next)
    next.on('message', () => { calls++ })
    await next.handleUpdate(update)
    expect(calls).toBe(2)
  })
})
