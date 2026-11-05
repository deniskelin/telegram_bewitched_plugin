import { describe, test, expect } from 'bun:test'
import { Store } from '../src/db.ts'
import { settingsScreen, advancedSettingsScreen } from '../src/daemon/hub.ts'
import { selectTask, selectedTask, applyTask, prepareFile, handleTaskCallback } from '../src/daemon/tasks.ts'
import type { Daemon } from '../src/daemon/daemon.ts'
import type { Context } from 'grammy'

const c = { chatId: '111', isPrivate: true }
function fixture() {
  const sent: string[] = [], delivered: { text: string; meta: Record<string, string> }[] = []
  const d = { store: new Store(':memory:'), botUsername: 'testbot', userIdOf: () => null, isTopicsChat: () => false, userShortName: () => 'Owner', userSession: () => ({ projectName: 'Personal', topic: null, group: null }), log: () => {}, routeText: async (_c: unknown, _u: string, text: string, meta: Record<string, string>) => { delivered.push({ text, meta }) } } as unknown as Daemon
  const ctx = { from: { id: 111 }, chat: { id: 111, type: 'private' }, callbackQuery: { message: { message_id: 1, chat: { id: 111 } } }, reply: async (text: string) => { sent.push(text) }, editMessageText: async (text: string) => { sent.push(text) }, editMessageReplyMarkup: async () => {}, answerCallbackQuery: async () => {} } as unknown as Context
  return { d, ctx, sent, delivered }
}
describe('settings and task entry', () => {
  test('basic settings contain language/voice/answer detail, advanced settings keep transport and global quiet hours', () => {
    const { d } = fixture()
    const basic = settingsScreen(d, c), advanced = advancedSettingsScreen(d, c)
    const b = JSON.stringify(basic.kb), a = JSON.stringify(advanced.kb)
    for (const key of ['hub:lg:ru', 'hub:vo:off', 'hub:ad:short', 'hub:agent', 'hub:advanced']) expect(b).toContain(key)
    expect(b).not.toContain('hub:sa:')
    expect(b).not.toContain('hub:qh:')
    for (const key of ['hub:sa:on', 'hub:sf:edit', 'hub:tc:on', 'hub:qh:2', 'hub:set']) expect(a).toContain(key)
    expect(basic.text).toContain('сразу')
  })
  test('task selection is one-shot, survives recreation and stays scoped to sender/chat/topic', () => {
    const { d } = fixture()
    selectTask(d, c, '111', 'review')
    expect(selectedTask(d, c, '111')).toBe('review')
    expect(selectedTask(d, c, '222')).toBeNull()
    expect(selectedTask(d, { ...c, threadId: 37 }, '111')).toBeNull()
    const meta: Record<string, string> = { user_role: 'member' }
    const result = applyTask(d, c, '111', 'source', meta)
    expect(result).toContain('Review the supplied material')
    expect(result).toContain('source')
    expect(meta).toMatchObject({ user_role: 'member', task_kind: 'review' })
    expect(meta.task_id).toMatch(/^[0-9a-f]{16}$/)
    expect(selectedTask(d, c, '111')).toBeNull()
    expect(applyTask(d, c, '111', 'next', {})).toBe('next')
  })
  test('expired task choices do not silently apply to a later message', () => {
    const { d } = fixture()
    d.store.set('task:intent:111:0:111', JSON.stringify({ kind: 'fix', at: Date.now() - 31 * 60_000 }))
    expect(selectedTask(d, c, '111')).toBeNull()
    expect(d.store.get('task:intent:111:0:111')).toBeNull()
  })
  test('bare file is retained, foreign callbacks cannot route it, one valid choice dispatches exactly once', async () => {
    const { d, ctx, sent, delivered } = fixture()
    await prepareFile(d, ctx, c, '111', '(document)', { chat_id: '111', message_id: '44', attachment_file_id: 'file', user_id: '111' })
    expect(sent[0]).toContain('Personal')
    expect(delivered).toHaveLength(0)
    const key = d.store.keys('task:file:')[0]!, id = key.slice('task:file:'.length)
    const otherChat = { ...ctx, chat: { id: 222, type: 'private' } } as unknown as Context
    await handleTaskCallback(d, otherChat, `tk:file:${id}:fix`)
    expect(delivered).toHaveLength(0)
    await handleTaskCallback(d, ctx, `tk:file:${id}:check`)
    await handleTaskCallback(d, ctx, `tk:file:${id}:fix`)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.meta).toMatchObject({ attachment_file_id: 'file', task_kind: 'check', user_role: 'owner' })
    expect(delivered[0]!.text).toContain('(document)')
    expect(JSON.parse(d.store.get(key)!).delivered).toBe(true)
  })
  test('a failed file route stays retryable and does not claim delivery', async () => {
    const { d, ctx, delivered } = fixture()
    await prepareFile(d, ctx, c, '111', 'file', { chat_id: '111', message_id: '45' })
    const key = d.store.keys('task:file:')[0]!, id = key.slice('task:file:'.length)
    const route = d.routeText
    d.routeText = async () => { throw new Error('offline') }
    await handleTaskCallback(d, ctx, `tk:file:${id}:review`)
    expect(JSON.parse(d.store.get(key)!).delivered).not.toBe(true)
    d.routeText = route
    await handleTaskCallback(d, ctx, `tk:file:${id}:review`)
    expect(delivered).toHaveLength(1)
  })
})
