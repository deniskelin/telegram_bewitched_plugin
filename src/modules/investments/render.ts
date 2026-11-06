import { escapeHtml } from '../../format.ts'
import { t, locale } from '../../i18n/index.ts'
import { cashFlows, format, formatQuantity, multiply, performance } from './core.ts'
import { InvestmentRepository } from './repository.ts'
import type { Config, Snapshot } from './types.ts'
const stamp = (at: number, zone: string) => new Date(at).toLocaleString(locale(), { timeZone: zone })
export function render(
  c: Config,
  r: InvestmentRepository,
  section = 'summary',
  now = Date.now(),
  since = now - 86400_000
): string {
  const lines = [t('📈 <b>Инвестиции</b>'), `<i>${escapeHtml(stamp(now, c.timezone))} · ${escapeHtml(c.timezone)}</i>`]
  if (!c.enabled || r.read('paused', false)) lines.push(t('Мониторинг выключен'))
  if (!c.accounts.length) lines.push(t('Счета ещё не подключены'))
  for (const account of c.accounts) {
    if (section === 'strategy' && !account.strategy) continue
    const data = r.account(account.id)
    lines.push('', `<b>${escapeHtml(account.name)}</b>${account.strategy ? ' · ' + t('Счёт стратегии') : ''}`)
    if (!data) {
      lines.push(t('Нет данных'))
      continue
    }
    lines.push(
      `${format(BigInt(data.snapshot.nav))} ${escapeHtml(data.snapshot.currency.toUpperCase())} · ${escapeHtml(stamp(data.snapshot.at, c.timezone))}`
    )
    if (now - data.snapshot.at > 20 * 60_000) lines.push(t('Данные устарели'))
    if (r.read('health:account:' + account.id, 0) > 0 || data.warnings.length > 0) lines.push(t('Данные неполные'))
    const ops = data.operations.filter((o) => o.at >= since && o.at <= now),
      cash = cashFlows(ops, data.snapshot.currency)
    if (section === 'operations' || section === 'evening' || section === 'strategy') {
      const baseline = r.read<Snapshot | undefined>('baseline:' + account.id, undefined),
        pnl = baseline && baseline.at >= since ? performance(baseline, data.snapshot, ops) : null
      if (baseline && baseline.at >= since)
        lines.push(`${t('Начало наблюдения')}: ${escapeHtml(stamp(baseline.at, c.timezone))}`)
      lines.push(`${t('Результат')}: ${pnl === null ? t('Не рассчитано') : format(pnl) + ' ' + data.snapshot.currency}`)
      lines.push(
        `${t('Поступления')}: ${format(cash.income)} · ${t('Комиссии')}: ${format(cash.fees)} · ${t('Налоги')}: ${format(cash.tax)}`
      )
      if (cash.incomplete) lines.push(t('Данные неполные'))
      for (const op of (section === 'evening' ? ops.slice(-20) : ops).slice().reverse())
        lines.push(
          `${escapeHtml(stamp(op.at, c.timezone))} · ${escapeHtml(op.type.replace('OPERATION_TYPE_', ''))} · ${escapeHtml(op.state.replace('OPERATION_STATE_', ''))} · ${format(BigInt(op.amount))} ${escapeHtml(op.currency)}`
        )
    }
    if (section === 'portfolio' || section === 'evening') {
      const baseline = r.read<Snapshot | undefined>('baseline:' + account.id, undefined)
      const old = new Map(baseline?.positions.map((p) => [p.id, p]) ?? [])
      const moves = data.snapshot.positions
        .flatMap((p) => {
          const b = old.get(p.id)
          return b && BigInt(b.price) > 0n
            ? [
                {
                  id: p.name ?? p.id,
                  pct: Number(((BigInt(p.price) - BigInt(b.price)) * 10000n) / BigInt(b.price)) / 100
                }
              ]
            : []
        })
        .sort((a, b) => b.pct - a.pct)
      if (section === 'evening')
        for (const move of [...new Map([...moves.slice(0, 3), ...moves.slice(-3)].map((m) => [m.id, m])).values()])
          lines.push(`${escapeHtml(move.id)} · Δ ${move.pct}%`)

      lines.push('<blockquote expandable><b>' + t('Позиции') + '</b>')
      for (const p of data.snapshot.positions)
        lines.push(
          `${escapeHtml(p.name ?? p.id)} · ${formatQuantity(BigInt(p.quantity))} · ${format(BigInt(p.price))} ${escapeHtml(p.currency)}`
        )
      lines.push('</blockquote>')
    }
    if (section === 'calendar') {
      lines.push(t('Объявленные выплаты; право на получение требует проверки'))
      for (const event of data.payments
        .filter((p) => !p.date || Date.parse(p.date) >= now - 86400_000)
        .sort((a, b) => a.date.localeCompare(b.date))) {
        lines.push(
          `${event.date ? escapeHtml(event.date.slice(0, 10)) : t('Нет данных')}${event.recordDate ? ' · ' + t('Дата реестра') + ': ' + escapeHtml(event.recordDate.slice(0, 10)) : ''} · ${escapeHtml(event.instrument)} · ${event.kind === 'coupon' ? t('Купон') : t('Дивиденд')} · ${event.amount === null ? t('Нет данных') : format(multiply(event.amount, event.quantity)) + ' ' + escapeHtml(event.currency)}`
        )
      }
      lines.push(`<b>${t('Поступления')}</b>`)
      for (const op of data.operations.filter(
        (o) =>
          o.at >= now - 30 * 86400_000 &&
          o.state === 'OPERATION_STATE_EXECUTED' &&
          /DIVIDEND|COUPON|BOND_REPAYMENT/.test(o.type) &&
          !/TAX/.test(o.type)
      ))
        lines.push(
          `${escapeHtml(stamp(op.at, c.timezone))} · ${escapeHtml(op.instrument)} · ${format(BigInt(op.amount))} ${escapeHtml(op.currency)}`
        )
      if (data.warnings.length) lines.push(t('Данные неполные'))
    }
  }
  if (section === 'news' || section === 'morning') {
    lines.push('', `<b>${t('Новости портфеля')}</b>`)
    if (!c.feeds.length) lines.push(t('Источники новостей не настроены'))
    for (const news of r
      .news()
      .filter(
        (n) =>
          n.at >= since &&
          n.instruments.some((id) =>
            c.accounts.some((a) => r.account(a.id)?.snapshot.positions.some((p) => p.id === id))
          )
      )
      .slice(0, section === 'morning' ? 5 : 1000))
      lines.push(`${escapeHtml(news.title)}\n<a href="${escapeHtml(news.url)}">${escapeHtml(news.source)}</a>`)
    if (c.feeds.some((f) => r.read('health:feed:' + f.name, 0) > 0)) lines.push(t('Данные неполные'))
    lines.push(t('Сценарии покупки и продажи без анализа агента не формируются'))
  }
  if (section === 'strategy') {
    const paper = r.read<{
      cash: string
      fees: string
      at: number
      trades: unknown[]
      tradeCount?: number
      initialCash?: string
      positions: Record<string, string>
    } | null>('paper', null)
    lines.push('', `<b>${t('Только симуляция')}</b>`)
    if (paper) {
      const quotes = new Map(
        c.accounts
          .flatMap((a) => r.account(a.id)?.snapshot.positions ?? [])
          .filter(
            (p) =>
              p.type === 'share' && p.currency.toLowerCase() === 'rub' && p.priceAt && now - p.priceAt <= 20 * 60_000
          )
          .map((p) => [p.id, p])
      )
      const complete = Object.keys(paper.positions).every((id) => quotes.has(id))
      const nav = complete
        ? BigInt(paper.cash) +
          Object.entries(paper.positions).reduce((sum, [id, q]) => sum + multiply(q, quotes.get(id)!.price), 0n)
        : null
      lines.push(
        `${t('Портфель')}: ${nav === null ? t('Не рассчитано') : format(nav) + ' RUB'} · ${t('Результат')}: ${nav === null || !paper.initialCash ? t('Не рассчитано') : format(nav - BigInt(paper.initialCash)) + ' RUB'}`
      )
    }
    if (paper)
      lines.push(
        `${t('Деньги')}: ${format(BigInt(paper.cash))} RUB · ${t('Комиссии')}: ${format(BigInt(paper.fees))} · ${t('Операции')}: ${paper.tradeCount ?? paper.trades.length}`
      )
    else lines.push(t('Нет данных'))
  }
  if (section === 'summary') {
    for (const a of c.accounts) {
      const s = r.account(a.id)?.snapshot
      if (!s || BigInt(s.nav) <= 0n) continue
      for (const p of s.positions) {
        if (p.type !== 'share' || p.currency.toLowerCase() !== s.currency.toLowerCase()) continue
        const weight = Number((multiply(p.price, p.quantity) * 10000n) / BigInt(s.nav)) / 100
        if (weight > c.maxPositionPct)
          lines.push(`${escapeHtml(a.name)} · ${escapeHtml(p.name ?? p.id)} · ${weight}% > ${c.maxPositionPct}%`)
      }
    }

    if (r.read('scheduleError', false)) lines.push(t('Расписание биржи недоступно'))
    lines.push(
      '',
      `${t('Проверок')}: ${r.read('cycles', 0)} · LLM: 0`,
      t('Реальные сделки выполняет только владелец у брокера')
    )
    if (!c.feeds.length) lines.push(t('Источники новостей не настроены'))
  }
  return lines.join('\n')
}
