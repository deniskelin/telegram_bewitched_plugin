/** Durable, scope-bound snapshots: page navigation never calls a model or re-collects usage. */
import { randomBytes } from 'crypto'
import type { Context } from 'grammy'
import type { Daemon } from './daemon.ts'
import type { Period } from './usage.ts'
export type UsageView = { id: string; chatId: string; threadId?: number; period: Period; page: number; pages: string[]; at: number; limits: { label: string; percent: number; resetsAt: string | null }[] }
const key = (id: string) => `usage:view:${id}`
export const saveUsageView = (d: Daemon, v: UsageView): void => d.store.set(key(v.id), JSON.stringify(v))
export const loadUsageView = (d: Daemon, id: string): UsageView | null => JSON.parse(d.store.get(key(id)) ?? 'null')
export function viewScope(ctx: Context): { chatId: string; threadId?: number } {
  const m = ctx.callbackQuery?.message ?? ctx.message
  return { chatId: String(ctx.chat?.id ?? m?.chat.id ?? ''), threadId: m && 'message_thread_id' in m ? m.message_thread_id : undefined }
}
export function ownsUsageView(v: UsageView, ctx: Context): boolean {
  const c = viewScope(ctx)
  return v.chatId === c.chatId && (v.threadId ?? 0) === (c.threadId ?? 0)
}
export function newUsageViewId(d: Daemon): string {
  for (const k of d.store.keys('usage:view:')) {
    const v = JSON.parse(d.store.get(k)!) as UsageView
    if (Date.now() - v.at > 7 * 86400_000) d.store.set(k, null)
  }
  return randomBytes(4).toString('hex')
}
const locks = new WeakMap<Daemon, Map<string, Promise<void>>>()
export async function lockUsageView<T>(d: Daemon, id: string, work: () => Promise<T>): Promise<T> {
  let map = locks.get(d); if (!map) { map = new Map(); locks.set(d, map) }
  const previous = map.get(id) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => gate); map.set(id, tail)
  await previous
  try { return await work() } finally { release(); if (map.get(id) === tail) map.delete(id) }
}
