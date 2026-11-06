/** Local paper-only allocation simulator. Never calls a broker order endpoint. */
import { decimal, multiply } from './core.ts'
import type { Config, Position } from './types.ts'
export type Paper = {
  at: number
  initialCash?: string
  tradeCount?: number
  cash: string
  positions: Record<string, string>
  fees: string
  trades: { at: number; instrument: string; quantity: string; price: string; fee: string }[]
}
export function paperStep(
  before: Paper | undefined,
  config: NonNullable<Config['paper']>,
  prices: Position[],
  now: number
): Paper {
  const state: Paper = before
    ? structuredClone(before)
    : {
        at: 0,
        initialCash: decimal(config.cash).toString(),
        tradeCount: 0,
        cash: decimal(config.cash).toString(),
        positions: {},
        fees: '0',
        trades: []
      }
  if (state.at >= now) return state
  const quotes = new Map(
    prices
      .filter((p) => p.type === 'share' && p.currency.toLowerCase() === 'rub' && BigInt(p.price) > 0n)
      .map((p) => [p.id, BigInt(p.price)])
  )
  const ids = new Set([...Object.keys(state.positions), ...Object.keys(config.weights)])
  // Do not value an unavailable holding at zero or rebalance against a partial market.
  if ([...ids].some((id) => !quotes.has(id))) return state
  const scale = 1_000_000_000n
  let nav = BigInt(state.cash)
  for (const [id, q] of Object.entries(state.positions)) nav += (BigInt(q) * quotes.get(id)!) / scale
  const targets = new Map(
    [...ids].map((id) => [
      id,
      ((nav * BigInt(Math.round((config.weights[id] ?? 0) * 100))) / 10000n / quotes.get(id)!) * scale
    ])
  )
  for (const buying of [false, true])
    for (const id of ids) {
      const price = quotes.get(id)!,
        current = BigInt(state.positions[id] ?? 0),
        delta = targets.get(id)! - current
      if (!delta || delta > 0n !== buying) continue
      let quantity = delta
      if (buying) {
        const cash = BigInt(state.cash),
          affordable = ((cash * 10000n) / (10000n + BigInt(Math.ceil(config.feeBps))) / price) * scale
        if (quantity > affordable) quantity = affordable
        if (quantity <= 0n) continue
      }
      const value = (quantity * price) / scale,
        fee = ((value < 0n ? -value : value) * BigInt(Math.ceil(config.feeBps))) / 10000n
      state.cash = (BigInt(state.cash) - value - fee).toString()
      state.positions[id] = (current + quantity).toString()
      state.fees = (BigInt(state.fees) + fee).toString()
      state.tradeCount = (state.tradeCount ?? state.trades.length) + 1
      state.trades.push({
        at: now,
        instrument: id,
        quantity: quantity.toString(),
        price: price.toString(),
        fee: fee.toString()
      })
    }
  state.at = now
  state.trades = state.trades.slice(-1000)
  return state
}
