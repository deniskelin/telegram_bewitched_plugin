/** Task lifecycle and scope rules; adapters own IDs, clocks and persistence. */
export type TaskScope = { chatId: string; threadId?: number; isPrivate: boolean }
export type Task = { id: string; chat: TaskScope; user: string; state: 'open' | 'ready' | 'closed'; at: number; updated: number }
export function ownsTask(task: Task, chat: TaskScope, user: string): boolean {
  return task.user === user && task.chat.chatId === chat.chatId && (task.chat.threadId ?? 0) === (chat.threadId ?? 0)
}
export function transitionTask(task: Task, state: Task['state'], at: number): Task {
  // A late result must never silently reopen an explicitly closed task.
  if (task.state === 'closed' && state === 'ready') return task
  return { ...task, state, updated: at }
}
export function scopeAfterTransition(current: string | null, task: Task): string | null {
  if (task.state === 'open') return task.id
  if (task.state === 'closed' && current === task.id) return null
  return current
}

/** Storage port: implementations may use SQLite, a file, or an in-memory test store. */
export interface TaskRepository {
  get(id: string): Task | null
  commit(task: Task, currentId: string | null): void
  current(chat: TaskScope, user: string): string | null
}
export class Tasks {
  constructor(private repository: TaskRepository, private id: () => string, private now: () => number) {}
  create(chat: TaskScope, user: string): Task {
    const at = this.now()
    const task: Task = { id: this.id(), chat: { ...chat }, user, state: 'open', at, updated: at }
    this.repository.commit(task, task.id)
    return task
  }
  change(id: string, state: Task['state']): Task | null {
    const previous = this.repository.get(id)
    if (!previous) return null
    const task = transitionTask(previous, state, this.now())
    this.repository.commit(task, scopeAfterTransition(this.repository.current(task.chat, task.user), task))
    return task
  }
}

/** Durable batches/resume events must retain every task identity and intent. */
export function taskBatchMeta(metas: Record<string, string>[]): Record<string, string> {
  const ids = [...new Set(metas.flatMap(m => (m.task_ids ?? m.task_id ?? '').split(',')).filter(Boolean))]
  const identity: Record<string, string> = ids.length === 1 ? { task_id: ids[0]! } : ids.length ? { task_id: '', task_ids: ids.join(',') } : {}
  const kinds = [...new Set(metas.map(m => m.task_kind).filter(Boolean))]
  if (kinds.length === 1) return { ...identity, task_kind: kinds[0]! }
  if (kinds.length > 1) return { ...identity, task_kind: '', task_kinds: kinds.join(',') }
  return identity
}
