/** Fixed read-only API surface. No generic method forwarding or order endpoints. */
import { nano } from './core.ts'
import type { AccountConfig, AccountData, Broker, Money, Operation, Payment, Position, TradingDay } from './types.ts'
const BASE = 'https://invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1.'
export class ReadOnlyBroker implements Broker {
  private next = 0
  constructor(
    private readonly token: (env: string) => string | undefined = (e) => process.env[e],
    private readonly fetcher: typeof fetch = fetch,
    private readonly credential: string | (() => string) = ''
  ) {}
  private async call(service: string, method: string, body: unknown, env: string): Promise<any> {
    const token = this.token(env)
    if (!token) throw new Error('Broker credential not configured')
    const wait = Math.max(0, this.next - Date.now())
    this.next = Date.now() + wait + 250
    if (wait) await new Promise((r) => setTimeout(r, wait))
    let response: Response
    try {
      response = await this.fetcher(BASE + service + '/' + method, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error'
      })
    } catch {
      throw new Error('Broker network unavailable')
    }
    if (!response.ok) throw new Error(`Broker request failed (${response.status})`)
    try {
      return await response.json()
    } catch {
      throw new Error('Broker response invalid')
    }
  }
  async account(c: AccountConfig, now: number, since: number): Promise<AccountData> {
    const accounts = await this.call('UsersService', 'GetAccounts', {}, c.tokenEnv)
    const account = accounts.accounts?.find((a: any) => a.id === c.id)
    if (!account || account.accessLevel !== 'ACCOUNT_ACCESS_LEVEL_READ_ONLY')
      throw new Error('Account requires a read-only token')
    const p = await this.call('OperationsService', 'GetPortfolio', { accountId: c.id, currency: 'RUB' }, c.tokenEnv)
    if (!p.totalAmountPortfolio || !Array.isArray(p.positions)) throw new Error('Portfolio response incomplete')
    const positions: Position[] = p.positions.map((i: any) => ({
      id: i.instrumentUid ?? i.figi,
      figi: i.figi ?? '',
      type: i.instrumentType,
      quantity: nano(i.quantity).toString(),
      price: nano(i.currentPrice).toString(),
      currency: i.currentPrice?.currency ?? '',
      expectedYield: nano(i.expectedYield ?? { units: 0 }).toString()
    }))
    if (positions.some((p) => !p.id || typeof p.type !== 'string')) throw new Error('Portfolio identity incomplete')
    const warnings: string[] = []
    const shares = positions.filter((p) => p.type === 'share')
    if (shares.length)
      try {
        const quotes = await this.call(
          'MarketDataService',
          'GetLastPrices',
          { instrumentId: shares.map((p) => p.id) },
          c.tokenEnv
        )
        for (const p of shares) {
          const quote = quotes.lastPrices?.find((q: any) => q.instrumentUid === p.id),
            stamp = Date.parse(quote?.time ?? '')
          if (quote && Number.isFinite(stamp) && stamp <= now + 60_000) {
            p.price = nano(quote.price).toString()
            p.priceAt = stamp
            p.name = quote.ticker
          }
        }
      } catch {
        warnings.push('quotes unavailable')
      }
    const operations: Operation[] = [],
      seen = new Set<string>()
    let cursor = ''
    for (let page = 0; ; page++) {
      if (page >= 1000) throw new Error('Operations pagination exceeded')
      const r = await this.call(
        'OperationsService',
        'GetOperationsByCursor',
        {
          accountId: c.id,
          from: new Date(since).toISOString(),
          to: new Date(now).toISOString(),
          cursor,
          limit: 1000,
          withoutCommissions: false,
          withoutTrades: false,
          withoutOvernights: false
        },
        c.tokenEnv
      )
      if (!Array.isArray(r.items)) throw new Error('Operations response incomplete')
      for (const o of r.items)
        if (!seen.has(o.id)) {
          if (
            typeof o.id !== 'string' ||
            typeof o.type !== 'string' ||
            typeof o.state !== 'string' ||
            !Number.isFinite(Date.parse(o.date))
          )
            throw new Error('Operation response invalid')
          seen.add(o.id)
          operations.push({
            id: o.id,
            at: Date.parse(o.date),
            type: o.type,
            state: o.state,
            amount: nano(o.payment).toString(),
            currency: o.payment?.currency ?? '',
            instrument: o.instrumentUid ?? o.figi ?? '',
            name: String(o.name ?? '')
          })
        }
      if (!r.hasNext) break
      if (!r.nextCursor || r.nextCursor === cursor) throw new Error('Operations cursor did not advance')
      cursor = r.nextCursor
    }
    const payments: Payment[] = []
    // Corporate-action requests are bounded and cached by the caller (daily refresh).
    return {
      snapshot: {
        at: now,
        account: c.id,
        nav: nano(p.totalAmountPortfolio).toString(),
        currency: p.totalAmountPortfolio.currency ?? 'rub',
        positions
      },
      operations,
      payments,
      warnings
    }
  }
  async calendar(c: AccountConfig, positions: Position[], now: number): Promise<Payment[]> {
    const out: Payment[] = [],
      from = new Date(now - 30 * 86400_000).toISOString(),
      to = new Date(now + 100 * 86400_000).toISOString()
    for (const p of positions.filter((p) => ['share', 'bond'].includes(p.type))) {
      const bond = p.type === 'bond',
        r = await this.call(
          'InstrumentsService',
          bond ? 'GetBondCoupons' : 'GetDividends',
          { instrumentId: p.id, from, to },
          c.tokenEnv
        )
      const events = bond ? r.events : r.dividends
      if (!Array.isArray(events)) throw new Error('Calendar response incomplete')
      for (const event of events) {
        const money: Money | undefined = bond ? event.payOneBond : event.dividendNet,
          rawDate = bond ? event.couponDate : event.paymentDate,
          recordDate = event.fixDate ?? event.recordDate,
          date = rawDate && Number.isFinite(Date.parse(rawDate)) ? rawDate : ''
        if (!date && (!recordDate || !Number.isFinite(Date.parse(recordDate)))) continue
        out.push({
          id: `${p.id}:${bond ? 'coupon' : 'dividend'}:${event.couponNumber ?? event.recordDate ?? date}`,
          instrument: p.id,
          kind: bond ? 'coupon' : 'dividend',
          date,
          recordDate,
          amount: money ? nano(money).toString() : null,
          currency: money?.currency ?? p.currency,
          status: 'announced',
          quantity: p.quantity
        })
      }
    }
    return out
  }
  async schedule(now: number): Promise<TradingDay[]> {
    const r = await this.call(
      'InstrumentsService',
      'TradingSchedules',
      {
        exchange: 'MOEX',
        from: new Date(now - 2 * 86400_000).toISOString(),
        to: new Date(now + 8 * 86400_000).toISOString()
      },
      typeof this.credential === 'function' ? this.credential() : this.credential
    )
    const exchange = r.exchanges?.find((e: any) => e.exchange === 'MOEX')
    if (!Array.isArray(exchange?.days)) throw new Error('Trading schedule unavailable')
    return exchange.days
  }
}

export async function inspectReadOnlyAccounts(
  token: string,
  fetcher: typeof fetch = fetch
): Promise<import('./accounts.ts').BrokerAccount[]> {
  if (!token || token.length > 4096 || /[\s\x00-\x1f]/.test(token)) throw new Error('Invalid credential')
  let response: Response
  try {
    response = await fetcher(BASE + 'UsersService/GetAccounts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15000),
      redirect: 'error'
    })
  } catch {
    throw new Error('Broker unavailable')
  }
  if (!response.ok) throw new Error('Read-only account verification failed')
  const data = await response.json()
  if (
    !Array.isArray(data.accounts) ||
    !data.accounts.length ||
    data.accounts.some((a: any) => a.accessLevel !== 'ACCOUNT_ACCESS_LEVEL_READ_ONLY')
  )
    throw new Error('Read-only credential required')
  const open = data.accounts.filter((a: any) => a.status === 'ACCOUNT_STATUS_OPEN')
  if (!open.length) throw new Error('No open accounts')
  return open.map((a: any) => {
    if (typeof a.id !== 'string' || !/^[\w-]{1,100}$/.test(a.id)) throw new Error('Invalid broker identity')
    return {
      id: a.id,
      name: typeof a.name === 'string' ? a.name.slice(0, 60) : a.id,
      type: typeof a.type === 'string' ? a.type.slice(0, 100) : 'ACCOUNT_TYPE_UNSPECIFIED'
    }
  })
}

/** Probe the selected portfolio before a credential becomes persistent. */
export async function probeReadOnlyAccount(token: string, id: string, fetcher: typeof fetch = fetch): Promise<void> {
  const accounts = await inspectReadOnlyAccounts(token, fetcher)
  if (!accounts.some((a) => a.id === id)) throw new Error('Account unavailable')
  const response = await fetcher(BASE + 'OperationsService/GetPortfolio', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: id, currency: 'RUB' }),
    signal: AbortSignal.timeout(15000),
    redirect: 'error'
  })
  if (!response.ok) throw new Error('Portfolio unavailable')
  const data = await response.json()
  if (!Array.isArray(data.positions) || !data.totalAmountPortfolio) throw new Error('Portfolio incomplete')
  nano(data.totalAmountPortfolio)
}
