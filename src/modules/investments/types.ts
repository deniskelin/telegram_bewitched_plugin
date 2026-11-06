export type KV = {
  get(k: string): string | null
  set(k: string, v: string | null): void
  keys(prefix: string): string[]
}
export type Money = { units?: string | number; nano?: number; currency?: string }
export type AccountConfig = {
  id: string
  name: string
  tokenEnv: string
  credentialRef?: string
  brokerType?: string
  strategy?: boolean
}
export type Config = {
  enabled: boolean
  criticalSound?: boolean
  chatId: string
  threadId: number
  timezone: string
  morning: string
  close: 'main' | 'last'
  accounts: AccountConfig[]
  feeds: { url: string; name: string; keywords: Record<string, string[]> }[]
  maxPositionPct: number
  priceAlertPct: number
  portfolioImpactPct: number
  paper?: { cash: string; weights: Record<string, number>; feeBps: number }
}
export type Position = {
  id: string
  figi: string
  type: string
  quantity: string
  price: string
  currency: string
  expectedYield: string
  name?: string
  priceAt?: number
}
export type Snapshot = { at: number; account: string; nav: string; currency: string; positions: Position[] }
export type Operation = {
  id: string
  at: number
  type: string
  state: string
  amount: string
  currency: string
  instrument: string
  name: string
}
export type Payment = {
  id: string
  instrument: string
  kind: 'coupon' | 'dividend'
  date: string
  recordDate?: string
  amount: string | null
  currency: string
  status: 'announced' | 'expected'
  quantity: string
}
export type TradingDay = {
  date: string
  isTradingDay: boolean
  startTime?: string
  endTime?: string
  closingAuctionEndTime?: string
  eveningEndTime?: string
}
export type News = {
  id: string
  at: number
  title: string
  url: string
  source: string
  instruments: string[]
  critical: boolean
}
export type AccountData = {
  snapshot: Snapshot
  operations: Operation[]
  payments: Payment[]
  warnings: string[]
  calendarFresh?: boolean
}
export type Broker = {
  account(c: AccountConfig, now: number, since: number): Promise<AccountData>
  schedule(now: number): Promise<TradingDay[]>
  calendar?(c: AccountConfig, p: Position[], now: number): Promise<Payment[]>
}
