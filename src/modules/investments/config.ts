import { readFileSync, statSync } from 'fs'
import type { Config } from './types.ts'
export function validateConfig(value: unknown): Config {
  const c = value as Config
  if (
    !c ||
    typeof c.enabled !== 'boolean' ||
    !/^-[0-9]+$/.test(c.chatId) ||
    !Number.isSafeInteger(c.threadId) ||
    c.threadId <= 0
  )
    throw new Error('Invalid investments destination')
  if (c.criticalSound !== undefined && typeof c.criticalSound !== 'boolean')
    throw new Error('Invalid critical notification setting')
  if (typeof c.timezone !== 'string' || !c.timezone) throw new Error('Explicit timezone required')
  new Intl.DateTimeFormat('en', { timeZone: c.timezone })
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c.morning) || !['main', 'last'].includes(c.close))
    throw new Error('Invalid investments schedule')
  if (
    !Array.isArray(c.accounts) ||
    c.accounts.length > 4 ||
    new Set(c.accounts.map((a) => a.id)).size !== c.accounts.length
  )
    throw new Error('Invalid investments accounts')
  for (const a of c.accounts)
    if (
      typeof a.id !== 'string' ||
      !/^[\w-]{1,100}$/.test(a.id) ||
      typeof a.name !== 'string' ||
      !a.name ||
      a.name.length > 60 ||
      typeof a.tokenEnv !== 'string' ||
      !/^INVEST_[A-Z0-9_]+$/.test(a.tokenEnv) ||
      (a.strategy !== undefined && typeof a.strategy !== 'boolean')
    )
      throw new Error('Invalid account configuration')
  if (c.enabled && !c.accounts.length) throw new Error('Select accounts before enabling investments')
  if (c.accounts.filter((a) => a.strategy).length > 1) throw new Error('Only one strategy account')
  if (!Array.isArray(c.feeds) || c.feeds.length > 10) throw new Error('Invalid feeds')
  for (const f of c.feeds) {
    const u = new URL(f.url)
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      typeof f.name !== 'string' ||
      !f.name ||
      !f.keywords ||
      typeof f.keywords !== 'object' ||
      Array.isArray(f.keywords)
    )
      throw new Error('Invalid news feed')
    for (const words of Object.values(f.keywords))
      if (!Array.isArray(words) || words.some((w) => typeof w !== 'string' || w.length < 3))
        throw new Error('Invalid news matching')
  }
  for (const n of [c.maxPositionPct, c.priceAlertPct, c.portfolioImpactPct])
    if (!Number.isFinite(n) || n < 0.01 || n > 100) throw new Error('Invalid investment threshold')
  if (c.paper) {
    if (
      !/^\d+(\.\d{1,9})?$/.test(c.paper.cash) ||
      !Number.isFinite(c.paper.feeBps) ||
      c.paper.feeBps < 0 ||
      c.paper.feeBps > 1000 ||
      Object.values(c.paper.weights).some((n) => !Number.isFinite(n) || n < 0) ||
      Object.values(c.paper.weights).reduce((a, b) => a + b, 0) > 100
    )
      throw new Error('Invalid paper settings')
  }
  return c
}
export function loadInvestmentConfig(path = process.env.INVESTMENTS_CONFIG): Config | null {
  if (!path) return null
  const stat = statSync(path)
  if (stat.size > 128 * 1024 || (stat.mode & 0o077) !== 0)
    throw new Error('Investments config must be private (0600) and bounded')
  return validateConfig(JSON.parse(readFileSync(path, 'utf8')))
}
