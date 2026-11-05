import { taskBatchMeta } from '../core/task.ts'
export { taskBatchMeta } from '../core/task.ts'
/** Deterministic economy: durable batching, delivery receipts and context budgets. */
import { createHash } from 'crypto'
import type { Bot } from 'grammy'
import { can, assertAllowedChat, loadAccess, roleOf } from '../access.ts'
import { settings } from '../config.ts'
import type { Daemon, Session, ChatRef } from './daemon.ts'

export function countEconomy(d: Pick<Daemon, 'store'>, name: string, amount = 1): void {
  const key = `economy:metric:${new Date().toISOString().slice(0, 10)}:${name}`
  d.store.set(key, String(Number(d.store.get(key) ?? 0) + amount))
}

export function economyReport(d: Pick<Daemon, 'store'>): string {
  const prefix = `economy:metric:${new Date().toISOString().slice(0, 10)}:`
  return ['Economy · UTC · today', ...d.store.keys(prefix).sort().map(k => `${k.slice(prefix.length)}: ${d.store.get(k)}`),
    `Local actions without model (all time): ${d.store.get('fr9:saved') ?? 0}`,
    'Counters are events/characters, not estimated tokens or money. Actual tokens/cache/output: /usage.',
    `TEXT_BATCH_MS=${settings.textBatchMs}; RESUME_CONTEXT_CHARS=${settings.resumeContextChars}`].join('\n')
}

/** Successful Telegram updates are not re-executed after a daemon restart. */
export function installEconomy(d: Daemon, bot: Bot): void {
  const cutoff = Date.now() - 7 * 86400_000
  for (const key of d.store.keys('economy:receipt:')) if (Number(d.store.get(key)) < cutoff) d.store.set(key, null)
  bot.use(async (ctx, next) => {
    const key = `economy:receipt:${d.botId}:${ctx.update.update_id}`
    if (d.store.get(key)) { countEconomy(d, 'duplicate_updates'); return }
    await next()
    d.store.set(key, String(Date.now()))
  })
}

type Item = { text: string; meta: Record<string, string> }
type Batch = { chat: ChatRef; from: string; due: number; items: Item[] }
const timers = new WeakMap<Daemon, Map<string, ReturnType<typeof setTimeout>>>()
const running = new WeakMap<Daemon, Set<string>>()
function schedule(d: Daemon, key: string, delay: number): void {
  let map = timers.get(d)
  if (!map) { map = new Map(); timers.set(d, map) }
  if (map.has(key)) {
    if (delay > 0) return
    clearTimeout(map.get(key)); map.delete(key)
  }
  map.set(key, setTimeout(() => {
    map!.delete(key)
    void flushTextBatch(d, key).catch(err => { d.log(`batch failed: ${err}`); schedule(d, key, 2000) })
  }, Math.max(0, delay)))
}
export function restoreTextBatches(d: Daemon): void {
  for (const key of d.store.keys('economy:batch:')) schedule(d, key, 0)
}
export function queueTextBatch(d: Daemon, chat: ChatRef, from: string, text: string, meta: Record<string, string>): boolean {
  if (!settings.textBatchMs || !can(from, 'write')) return false
  const key = `economy:batch:${chat.chatId}:${chat.threadId ?? 0}:${from}`
  const raw = d.store.get(key)
  const b: Batch = raw ? JSON.parse(raw) : { chat, from, due: Date.now() + settings.textBatchMs, items: [] }
  if (!b.items.some(x => x.meta.message_id === meta.message_id)) b.items.push({ text, meta })
  d.store.set(key, JSON.stringify(b))
  schedule(d, key, b.items.length >= 16 || b.items.reduce((n, x) => n + x.text.length, 0) >= 12000 ? 0 : b.due - Date.now())
  return true
}
export async function flushTextBatch(d: Daemon, key: string): Promise<void> {
  let busy = running.get(d)
  if (!busy) { busy = new Set(); running.set(d, busy) }
  if (busy.has(key)) { schedule(d, key, 100); return }
  const raw = d.store.get(key)
  if (!raw) return
  busy.add(key)
  try {
    const b: Batch = JSON.parse(raw)
    const access = loadAccess()
    const policy = access.groups[b.chat.chatId]
    const revoked = access.dmPolicy === 'disabled' || !b.chat.isPrivate && (!policy || !policy.allowPaired && policy.allowFrom.length > 0 && !policy.allowFrom.includes(b.from))
    if (revoked || !can(b.from, 'write')) { d.store.set(key, null); return }
    try { assertAllowedChat(b.chat.chatId) } catch { d.store.set(key, null); return }
    const last = b.items.at(-1)!
    const text = b.items.length === 1 ? last.text : b.items.map(x => `[message_id=${x.meta.message_id}]\n${x.text}`).join('\n\n')
    await d.routeText(b.chat, b.from, text, { ...last.meta, ...taskBatchMeta(b.items.map(x => x.meta)), user_role: roleOf(b.from) ?? 'guest', message_ids: b.items.map(x => x.meta.message_id).join(','), batch_count: String(b.items.length) })
    // New messages may have arrived while routing/launching: only remove the delivered ones.
    const current: Batch = JSON.parse(d.store.get(key) ?? raw)
    const sent = new Set(b.items.map(x => x.meta.message_id))
    current.items = current.items.filter(x => !sent.has(x.meta.message_id))
    d.store.set(key, current.items.length ? JSON.stringify(current) : null)
    countEconomy(d, 'batched_messages', b.items.length)
    countEconomy(d, 'merged_deliveries', b.items.length - 1)
    if (current.items.length) schedule(d, key, 0)
  } finally { busy.delete(key) }
}

/** Only an explicit, known conversation may reuse receipts; a fresh conversation gets its context. */
function contextKey(s: Session): string | null {
  const argv = s.argv
  const at = argv.findIndex(a => a === '--resume' || a === '-r' || s.engine === 'codex' && a === 'resume')
  const id = s.claude.sessionId || (at >= 0 ? argv[at + 1] : null)
  return id && /^[\w-]+$/.test(id) ? `economy:context:${createHash('sha256').update(JSON.stringify([s.cwd, s.engine, id])).digest('hex')}` : null
}
type Seen = { messages: string[]; memory?: string }
const staged = new WeakMap<Session, { messages: [string, string[]][]; memory?: string }>()
export function activateContext(d: Pick<Daemon, 'store'>, s: Session, id: string): void {
  const pending = staged.get(s)
  if (!pending) return
  const known = { ...s, claude: { ...s.claude, sessionId: id } }
  for (const [chat, ids] of pending.messages) rememberContext(d, known, chat, ids)
  if (pending.memory != null) rememberMemory(d, known, pending.memory)
  staged.delete(s)
}
function readSeen(d: Pick<Daemon, 'store'>, s: Session): Seen {
  const key = contextKey(s)
  try {
    const value = key ? JSON.parse(d.store.get(key) ?? '{}') : {}
    return { messages: Array.isArray(value.messages) ? value.messages.filter((x: unknown) => typeof x === 'string') : [], ...(typeof value.memory === 'string' ? { memory: value.memory } : {}) }
  } catch { return { messages: [] } }
}
export function contextSeen(d: Pick<Daemon, 'store'>, s: Session, chatId: string, messageId: string): boolean {
  return readSeen(d, s).messages.includes(`${chatId}:${messageId}`)
}
export function rememberContext(d: Pick<Daemon, 'store'>, s: Session, chatId: string, ids: string[]): void {
  const key = contextKey(s)
  if (!key) {
    const pending = staged.get(s) ?? { messages: [] }
    pending.messages.push([chatId, ids]); pending.messages = pending.messages.slice(-200); staged.set(s, pending); return
  }
  const seen = readSeen(d, s)
  seen.messages = [...new Set([...seen.messages, ...ids.map(id => `${chatId}:${id}`)])].slice(-200)
  d.store.set(key, JSON.stringify(seen))
}
export function contextMemory(d: Pick<Daemon, 'store'>, s: Session, memory: string): string | null {
  const key = contextKey(s)
  if (!key) return memory
  const seen = readSeen(d, s)
  const hash = createHash('sha256').update(memory).digest('hex')
  if (seen.memory === hash) { countEconomy(d, 'memory_chars_omitted', memory.length); return null }
  // Caller marks the memory after it is delivered, including on a fresh conversation.
  return memory
}
export function rememberMemory(d: Pick<Daemon, 'store'>, s: Session, memory: string): void {
  const key = contextKey(s)
  if (!key) { const pending = staged.get(s) ?? { messages: [] }; pending.memory = memory; staged.set(s, pending); return }
  const seen = readSeen(d, s)
  seen.memory = createHash('sha256').update(memory).digest('hex')
  d.store.set(key, JSON.stringify(seen))
}
/** Keep newest whole history entries within a character budget; pending tasks are never truncated. */
export function budgetHistory<T extends { text: string }>(rows: T[], budget: number): T[] {
  const kept: T[] = []
  let used = 0
  for (const row of rows.slice().reverse()) {
    const size = Math.min(row.text.length, 400) + 80
    if (used + size > budget) break
    kept.unshift(row); used += size
  }
  return kept
}

/** Bounded history/search output; full messages remain available through get_message. */
export function boundedResult(text: string, budget: number): string {
  if (text.length <= budget || budget === 0) return text
  const note = '\n[truncated; use get_message for a full message or narrow the query]'
  if (budget < note.length) return note.slice(0, budget)
  return Array.from(text.slice(0, Math.max(0, budget - note.length))).join('').replace(/[\uD800-\uDBFF]$/, '') + note
}

/** A stop must not be followed by an older message still in the batching window. */
export function cancelTextBatch(d: Daemon, chat: ChatRef, from: string): boolean {
  const key = `economy:batch:${chat.chatId}:${chat.threadId ?? 0}:${from}`
  if (!d.store.get(key)) return false
  d.store.set(key, null)
  const timer = timers.get(d)?.get(key)
  if (timer) clearTimeout(timer)
  timers.get(d)?.delete(key)
  countEconomy(d, 'cancelled_batches')
  return true
}
