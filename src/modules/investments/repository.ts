import { createHash } from 'crypto'
import type { KV, AccountData, News, Operation, Payment, Snapshot } from './types.ts'
export class InvestmentRepository {
  readonly prefix: string
  constructor(
    readonly store: KV,
    scope = ''
  ) {
    this.prefix = 'invest:' + (scope ? createHash('sha256').update(scope).digest('hex').slice(0, 16) + ':' : '')
  }
  keys(prefix: string): string[] {
    return this.store.keys(this.prefix + prefix).map((k) => k.slice(this.prefix.length))
  }
  read<T>(key: string, fallback: T): T {
    const raw = this.store.get(this.prefix + key)
    return raw === null ? fallback : JSON.parse(raw)
  }
  save(key: string, value: unknown): void {
    this.store.set(this.prefix + key, JSON.stringify(value))
  }
  prune(now: number): void {
    for (const key of this.keys('outbox:')) {
      const job = this.read<any>(key, null)
      if (job?.status === 'sent' && now - job.at > 30 * 86400_000) this.store.set(this.prefix + key, null)
    }
  }
  account(id: string): AccountData | null {
    return this.read('account:' + id, null)
  }
  saveAccount(id: string, data: AccountData): void {
    const before = this.account(id),
      ops = new Map((before?.operations ?? []).map((o) => [o.id, o]))
    for (const o of data.operations) ops.set(o.id, o)
    // Retain a bounded history; historical summaries must disclose the lower bound.
    const operations = [...ops.values()]
      .filter((o) => o.at >= data.snapshot.at - 100 * 86400_000)
      .sort((a, b) => a.at - b.at)
    this.save('account:' + id, {
      ...data,
      operations,
      payments: data.calendarFresh ? data.payments : (before?.payments ?? [])
    })
  }
  news(): News[] {
    return this.read('news', [])
  }
  saveNews(news: News[], now: number): void {
    const all = new Map(this.news().map((n) => [n.id, n]))
    for (const n of news) all.set(n.id, n)
    this.save(
      'news',
      [...all.values()]
        .filter((n) => n.at >= now - 7 * 86400_000)
        .sort((a, b) => b.at - a.at)
        .slice(0, 1000)
    )
  }
  queue(id: string, text: string, now: number, ack?: { key: string; value: unknown }, urgent = false): void {
    const key = 'outbox:' + createHash('sha256').update(id).digest('hex').slice(0, 32)
    if (!this.store.get(this.prefix + key))
      this.save(key, { id, text, at: now, attempts: 0, next: 0, status: 'pending', ack, urgent, page: 0 })
  }
}
