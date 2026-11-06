import { htmlPages } from '../../core/html-pages.ts'
import { t } from '../../i18n/index.ts'
import { escapeHtml } from '../../format.ts'
import { format, closeAt, localClock, localDay, dayStart } from './core.ts'
import { fetchNews } from './news.ts'
import { paperStep, type Paper } from './paper.ts'
import { render } from './render.ts'
import { InvestmentRepository } from './repository.ts'
import type { Broker, Config, News, Snapshot, TradingDay } from './types.ts'
export class InvestmentService {
  private busy = false
  private generation = 0
  settingsChanged(): void {
    this.generation++
    this.repo.save('lastAttempt', 0)
    for (const key of this.repo.keys('outbox:')) {
      const job = this.repo.read<any>(key, null)
      if (job?.status === 'pending') this.repo.save(key, { ...job, status: 'cancelled', text: '', pages: [] })
    }
  }
  get running(): boolean {
    return this.busy
  }
  constructor(
    readonly config: Config,
    readonly repo: InvestmentRepository,
    private readonly broker: Broker,
    private readonly send: (text: string, urgent?: boolean) => Promise<number>,
    private readonly news = fetchNews
  ) {}
  private enqueue(id: string, text: string, now: number, ack?: { key: string; value: unknown }): void {
    this.repo.queue(id, text, now, ack, /^(news|move|health|feed-health):/.test(id))
  }
  async flush(now: number): Promise<void> {
    const generation = this.generation
    const jobs = this.repo
      .keys('outbox:')
      .map((key) => ({ key, job: this.repo.read<any>(key, null) }))
      .filter((j) => j.job?.status === 'pending')
      .sort((a, b) => a.job.at - b.job.at)
    for (const { key, job } of jobs) {
      if (generation !== this.generation || this.repo.read('paused', false) || job.next > now) break
      try {
        job.pages ??= htmlPages(job.text)
        job.page ??= 0
        this.repo.save(key, job)
        while (job.page < job.pages.length) {
          if (generation !== this.generation || this.repo.read('paused', false)) return
          job.message = await this.send(job.pages[job.page], job.urgent)
          if (generation !== this.generation) return
          job.page++
          this.repo.save(key, job)
        }
        if (job.ack) this.repo.save(job.ack.key, job.ack.value)
        job.status = 'sent'
        this.repo.save(key, job)
      } catch {
        if (generation !== this.generation) return
        job.attempts++
        job.next = now + Math.min(300_000, 2000 * 2 ** Math.min(8, job.attempts))
        this.repo.save(key, job)
        break
      }
      this.repo.save(key, job)
    }
  }
  async tick(now = Date.now(), force = false): Promise<void> {
    if (this.busy || !this.config.enabled || this.repo.read('paused', false)) return
    const generation = this.generation
    this.busy = true
    try {
      if (!force && now - this.repo.read('lastAttempt', 0) < 600_000) {
        await this.flush(now)
        return
      }
      this.repo.save('lastAttempt', now)
      this.repo.prune(now)
      const day = localDay(now, this.config.timezone),
        held = new Set<string>(),
        previous = new Map<string, Snapshot>()
      let successful = 0
      for (const a of this.config.accounts) {
        const old = this.repo.account(a.id)
        if (old) previous.set(a.id, old.snapshot)
        try {
          const data = await this.broker.account(
            a,
            now,
            old ? Math.max(now - 90 * 86400_000, old.snapshot.at - 2 * 86400_000) : now - 90 * 86400_000
          )
          if (generation !== this.generation) return
          if (this.broker.calendar && this.repo.read('calendarDay:' + a.id, '') !== day) {
            try {
              data.payments = await this.broker.calendar(a, data.snapshot.positions, now)
              if (generation !== this.generation) return
              data.calendarFresh = true
            } catch {
              data.warnings.push('calendar unavailable')
            }
          }
          if (generation !== this.generation) return
          this.repo.saveAccount(a.id, data)
          if (data.calendarFresh) this.repo.save('calendarDay:' + a.id, day)
          successful++
          const oldOps = new Map(old?.operations.map((o) => [o.id, o]) ?? [])
          for (const op of data.operations) {
            const prior = oldOps.get(op.id)
            if (prior && (prior.state !== op.state || prior.amount !== op.amount))
              this.enqueue(
                'operation-update:' + a.id + ':' + op.id + ':' + op.state + ':' + op.amount,
                `${t('Данные неполные')} · ${escapeHtml(a.name)}\n${escapeHtml(op.name)} · ${escapeHtml(op.state)} · ${format(BigInt(op.amount))} ${escapeHtml(op.currency)}`,
                now
              )
            if (
              op.at >= now - 20 * 60_000 &&
              op.at <= now &&
              op.state === 'OPERATION_STATE_EXECUTED' &&
              /DIVIDEND|COUPON|BOND_REPAYMENT/.test(op.type) &&
              !/TAX/.test(op.type)
            )
              this.enqueue(
                'receipt:' + a.id + ':' + op.id,
                `${t('Поступления')} · ${escapeHtml(a.name)}\n${escapeHtml(op.name)} · ${format(BigInt(op.amount))} ${escapeHtml(op.currency)}\n${new Date(op.at).toISOString()}`,
                now
              )
          }
          const current = this.repo.account(a.id)!
          if (this.repo.read('calendarDay:' + a.id, '') === day)
            for (const payment of current.payments) {
              const days = Math.ceil((Date.parse(payment.date) - now) / 86400_000)
              if (days === 1 || days === 7)
                this.enqueue(
                  'payment:' + a.id + ':' + payment.id + ':' + payment.date + ':' + days,
                  `${t('Календарь выплат')} · ${escapeHtml(a.name)}\n${escapeHtml(payment.instrument)} · ${escapeHtml(payment.date.slice(0, 10))}\n${t('Объявленные выплаты; право на получение требует проверки')}`,
                  now
                )
            }
          if (this.repo.read('baselineDay:' + a.id, '') !== day) {
            this.repo.save('baseline:' + a.id, data.snapshot)
            this.repo.save('baselineDay:' + a.id, day)
          }
          if (this.repo.read('health:account:' + a.id, 0) >= 2)
            this.enqueue(
              'recovery:' + a.id + ':' + now,
              t('Источник данных восстановлен') + ' · ' + escapeHtml(a.name),
              now
            )
          this.repo.save('health:account:' + a.id, 0)
        } catch {
          if (generation !== this.generation) return
          const count = this.repo.read('health:account:' + a.id, 0) + 1
          this.repo.save('health:account:' + a.id, count)
          if (count === 2)
            this.enqueue(
              'health:' + a.id + ':' + now,
              t('Проверка портфеля не выполнена') + ' · ' + escapeHtml(a.name),
              now
            )
        }
        const stored = this.repo.account(a.id)
        for (const p of stored?.snapshot.positions ?? []) held.add(p.id)
      }
      this.repo.save('cycles', this.repo.read('cycles', 0) + 1)
      for (const f of this.config.feeds) {
        try {
          const items = await this.news(f, held, now)
          if (generation !== this.generation) return
          this.repo.saveNews(items, now)
          if (this.repo.read('health:feed:' + f.name, 0) >= 2)
            this.enqueue(
              'feed-recovery:' + f.name + ':' + now,
              t('Источник данных восстановлен') + ' · ' + escapeHtml(f.name),
              now
            )
          this.repo.save('health:feed:' + f.name, 0)
          for (const n of items.filter((n) => n.critical && n.at >= now - 20 * 60_000))
            this.enqueue(
              'news:' + n.id,
              `${t('Требуется проверка новости по портфелю')}\n${escapeHtml(n.title)}\n${new Date(n.at).toISOString()}\n<a href="${escapeHtml(n.url)}">${escapeHtml(n.source)}</a>`,
              now
            )
        } catch {
          if (generation !== this.generation) return
          const count = this.repo.read('health:feed:' + f.name, 0) + 1
          this.repo.save('health:feed:' + f.name, count)
          if (count === 2)
            this.enqueue('feed-health:' + f.name + ':' + now, t('Данные неполные') + ' · ' + escapeHtml(f.name), now)
        }
      }
      if (this.config.accounts.length && now - this.repo.read('scheduleAt', 0) > 6 * 3600_000) {
        try {
          const schedule = await this.broker.schedule(now)
          if (generation !== this.generation) return
          this.repo.save('schedule', schedule)
          this.repo.save('scheduleAt', now)
          this.repo.save('scheduleError', false)
        } catch {
          if (generation !== this.generation) return
          this.repo.save('scheduleError', true)
        }
      }
      const schedule = this.repo.read<TradingDay[]>('schedule', []),
        today = schedule.find((s) => s.date.slice(0, 10) === day)
      const currentClose = today ? closeAt(today, this.config.close) : null
      // Price signals only compare two recent samples inside a known active session.
      if (
        today?.isTradingDay &&
        currentClose &&
        now < currentClose &&
        now >= Date.parse(today.startTime ?? '') &&
        now - this.repo.read('scheduleAt', 0) <= 8 * 3600_000
      )
        for (const a of this.config.accounts) {
          const old = previous.get(a.id),
            next = this.repo.account(a.id)?.snapshot
          if (!old || !next || next.at !== now || now - old.at > 20 * 60_000) continue
          const before = new Map(old.positions.map((p) => [p.id, p]))
          for (const p of next.positions) {
            const b = before.get(p.id)
            if (
              !b ||
              !p.priceAt ||
              !b.priceAt ||
              p.priceAt > now + 60_000 ||
              now - p.priceAt > 15 * 60_000 ||
              now - b.priceAt > 30 * 60_000 ||
              p.priceAt <= b.priceAt ||
              p.type !== 'share' ||
              p.currency.toLowerCase() !== next.currency.toLowerCase() ||
              BigInt(b.price) <= 0n ||
              BigInt(next.nav) <= 0n
            )
              continue
            const change = ((BigInt(p.price) - BigInt(b.price)) * 10000n) / BigInt(b.price),
              abs = change < 0n ? -change : change,
              impact =
                ((((BigInt(p.price) - BigInt(b.price)) * BigInt(p.quantity)) / 1_000_000_000n) * 10000n) /
                BigInt(next.nav),
              exposure = impact < 0n ? -impact : impact
            if (
              abs >= BigInt(Math.round(this.config.priceAlertPct * 100)) &&
              exposure >= BigInt(Math.round(this.config.portfolioImpactPct * 100))
            )
              this.enqueue(
                'move:' +
                  a.id +
                  ':' +
                  p.id +
                  ':' +
                  day +
                  ':' +
                  (change < 0n ? 'down' : 'up') +
                  ':' +
                  String(abs / BigInt(Math.round(this.config.priceAlertPct * 100))),
                `${t('Резкое изменение цены; проверьте источник')}\n${escapeHtml(a.name)} · ${escapeHtml(p.id)} · ${Number(change) / 100}%`,
                now
              )
          }
        }
      if (successful && this.config.paper && this.repo.read('paperDay', '') !== day) {
        const prices = this.config.accounts.flatMap((a) => {
          const s = this.repo.account(a.id)?.snapshot
          return s?.at === now ? s.positions.filter((p) => p.priceAt && now - p.priceAt <= 15 * 60_000) : []
        })
        const paper = paperStep(this.repo.read<Paper | undefined>('paper', undefined), this.config.paper, prices, now)
        this.repo.save('paper', paper)
        if (paper.at === now) this.repo.save('paperDay', day)
      }
      if (localClock(now, this.config.timezone) >= this.config.morning && this.repo.read('morningDay', '') !== day) {
        const cutoff = this.repo.read('newsCutoff', now - 86400_000)
        this.enqueue('morning:' + day, render(this.config, this.repo, 'morning', now, cutoff), now, {
          key: 'newsCutoff',
          value: now
        })
        this.repo.save('morningDay', day)
      }
      if (currentClose && now >= currentClose + 5 * 60_000 && this.repo.read('eveningDay', '') !== day) {
        this.enqueue(
          'evening:' + day,
          render(this.config, this.repo, 'evening', now, dayStart(now, this.config.timezone)),
          now
        )
        if (this.config.accounts.some((a) => a.strategy) || this.config.paper)
          this.enqueue('strategy:' + day, render(this.config, this.repo, 'strategy', now), now + 1)
        this.repo.save('eveningDay', day)
      }
      if (!this.repo.read('paused', false)) await this.flush(now)
    } finally {
      this.busy = false
    }
  }
}
