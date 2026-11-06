import type { Money, Operation, Snapshot, TradingDay } from './types.ts'
const SCALE = 1_000_000_000n
export function nano(v: Money | undefined): bigint {
  if (!v || (v.units === undefined && !Number.isInteger(v.nano))) throw new Error('Missing monetary value')
  const units = String(v.units ?? 0)
  if (!/^-?\d+$/.test(units) || !Number.isInteger(v.nano ?? 0) || Math.abs(v.nano ?? 0) >= 1e9)
    throw new Error('Invalid monetary value')
  return BigInt(units) * SCALE + BigInt(v.nano ?? 0)
}
export function decimal(s: string): bigint {
  if (!/^-?\d+(\.\d{1,9})?$/.test(s)) throw new Error('Invalid decimal')
  const neg = s.startsWith('-'),
    [u, f = ''] = s.replace(/^-/, '').split('.')
  return (BigInt(u!) * SCALE + BigInt(f.padEnd(9, '0'))) * (neg ? -1n : 1n)
}
export function format(v: bigint): string {
  const sign = v < 0n ? '-' : '',
    a = v < 0n ? -v : v
  return (
    sign +
    String(a / SCALE) +
    '.' +
    String(a % SCALE)
      .padStart(9, '0')
      .slice(0, 2)
  )
}
export const multiply = (a: string, b: string): bigint => (BigInt(a) * BigInt(b)) / SCALE
export function localDay(now: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(now)
  )
}
export function localClock(now: number, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(now))
}
export function closeAt(day: TradingDay, mode: 'main' | 'last'): number | null {
  if (!day.isTradingDay) return null
  const date =
    mode === 'last'
      ? (day.eveningEndTime ?? day.closingAuctionEndTime ?? day.endTime)
      : (day.closingAuctionEndTime ?? day.endTime)
  const at = Date.parse(date ?? '')
  return Number.isFinite(at) ? at : null
}
export function executed(o: Operation): boolean {
  return o.state === 'OPERATION_STATE_EXECUTED'
}
export function cashFlows(
  ops: Operation[],
  currency: string
): { external: bigint; income: bigint; fees: bigint; tax: bigint; incomplete: boolean } {
  let external = 0n,
    income = 0n,
    fees = 0n,
    tax = 0n,
    incomplete = false
  for (const o of ops) {
    if (!executed(o)) continue
    if (o.currency.toUpperCase() !== currency.toUpperCase()) {
      incomplete = true
      continue
    }
    const value = BigInt(o.amount)
    if (['OPERATION_TYPE_INPUT', 'OPERATION_TYPE_OUTPUT'].includes(o.type)) external += value
    else if (/DIVIDEND|COUPON|BOND_REPAYMENT/.test(o.type) && !/TAX/.test(o.type)) income += value
    else if (/FEE|COMMISSION/.test(o.type)) fees += value
    else if (/TAX/.test(o.type)) tax += value
    else if (
      /TRANSFER|TRANS_|INP_MULTI|OUT_MULTI|INPUT|OUTPUT/.test(o.type) ||
      !/BUY|SELL|OVERNIGHT|BENEFIT|VARMARGIN|EXPIRATION|FUNDING|DELIVERY/.test(o.type)
    )
      incomplete = true
  }
  return { external, income, fees, tax, incomplete }
}
export function performance(before: Snapshot | undefined, after: Snapshot, ops: Operation[]): bigint | null {
  if (!before || before.currency.toUpperCase() !== after.currency.toUpperCase() || before.at >= after.at) return null
  const flow = cashFlows(
    ops.filter((o) => o.at > before.at && o.at <= after.at),
    after.currency
  )
  return flow.incomplete ? null : BigInt(after.nav) - BigInt(before.nav) - flow.external
}

export function dayStart(now: number, zone: string): number {
  const day = localDay(now, zone)
  let low = now - 48 * 3600_000,
    high = now
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)
    if (localDay(mid, zone) < day) low = mid
    else high = mid
  }
  return high
}

export function formatQuantity(v: bigint): string {
  const a = v < 0n ? -v : v,
    f = String(a % SCALE)
      .padStart(9, '0')
      .replace(/0+$/, '')
  return (v < 0n ? '-' : '') + String(a / SCALE) + (f ? '.' + f : '')
}
