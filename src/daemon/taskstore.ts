/** Persistence adapter. Keeps existing keys/data so deployment needs no migration. */
import type { Task, TaskRepository, TaskScope } from '../core/task.ts'
export interface KeyValueStore { get(key: string): string | null; set(key: string, value: string | null): void; atomic(write: () => void): void }
export const taskScopeKey = (c: TaskScope, user: string): string => `cost:current:${c.chatId}:${c.threadId ?? 0}:${user}`
export class JsonTaskRepository implements TaskRepository {
  constructor(private store: KeyValueStore) {}
  get(id: string): Task | null { return JSON.parse(this.store.get(`cost:task:${id}`) ?? 'null') }
  commit(task: Task, currentId: string | null): void {
    this.store.atomic(() => {
      this.store.set(`cost:task:${task.id}`, JSON.stringify(task))
      this.store.set(taskScopeKey(task.chat, task.user), currentId)
    })
  }
  current(chat: TaskScope, user: string): string | null { return this.store.get(taskScopeKey(chat, user)) }
}
