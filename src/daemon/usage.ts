/**
 * /usage: the subscription plan (from Claude Code's credentials file), its
 * limits (percent used and reset time, from the same undocumented endpoint
 * Claude Code's /usage calls) and token use counted from all transcripts,
 * priced at API rates.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { basename, join, relative } from 'path'
import { CONFIG_DIR, settings } from '../config.ts'
import { escapeHtml, fmtDuration } from '../format.ts'
import { InlineKeyboard, type Context } from 'grammy'
import { owner } from '../access.ts'
import { button } from './stream.ts'
import { isMessageNotModified } from '../tg.ts'
import type { Daemon, Session } from './daemon.ts'
import { commitsSince } from './git.ts'
import { locale, k, t as tr } from '../i18n/index.ts'

// --------------------------------------------------------------------------
// Plan
// --------------------------------------------------------------------------

type OAuth = { accessToken?: string; expiresAt?: number; subscriptionType?: string; rateLimitTier?: string }

function readOAuth(configDir = CONFIG_DIR): OAuth | null {
  try {
    return JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8')).claudeAiOauth ?? null
  } catch {
    return null
  }
}

/** "Max 20x", "Pro"; null when Claude Code logs in without a subscription (or keeps it in the keychain). */
export function planName(o: OAuth | null): string | null {
  if (!o?.subscriptionType) return null
  const name = o.subscriptionType[0].toUpperCase() + o.subscriptionType.slice(1)
  const x = /(\d+x)$/.exec(o.rateLimitTier ?? '')
  return x ? `${name} ${x[1]}` : name
}

// --------------------------------------------------------------------------
// Limits (undocumented endpoint)
// --------------------------------------------------------------------------

export type Limit = { label: string; percent: number; resetsAt: Date | null }
export type Limits = { items: Limit[]; breakdown: string | null }

type Window = { utilization?: number | null; resets_at?: string | null } | null
type UsageResponse = {
  five_hour?: Window
  seven_day?: Window
  seven_day_opus?: Window
  seven_day_sonnet?: Window
  limits?: { kind?: string; group?: string; percent?: number; resets_at?: string | null; scope?: string | null }[]
  seven_day_breakdown?: { rows?: { display_name?: string; percent?: number }[] } | null
}

const LIMIT_LABELS: Record<string, string> = {
  session: k('5 часов'),
  weekly_all: k('Неделя'),
  weekly_opus: k('Неделя, Opus'),
  weekly_sonnet: k('Неделя, Sonnet'),
}

/** The response shape changes without notice: read what is there, skip the rest. */
export function parseLimits(r: UsageResponse): Limits {
  const date = (s: string | null | undefined) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s) : null)
  const items: Limit[] = []
  if (Array.isArray(r.limits) && r.limits.length) {
    for (const l of r.limits) {
      if (typeof l.percent !== 'number' || !l.kind) continue
      const label = LIMIT_LABELS[l.kind] ?? (l.scope ? `${l.kind} (${l.scope})` : l.kind)
      items.push({ label, percent: l.percent, resetsAt: date(l.resets_at) })
    }
  } else {
    const windows: [string, Window | undefined][] = [
      [k('5 часов'), r.five_hour], [k('Неделя'), r.seven_day], [k('Неделя, Opus'), r.seven_day_opus], [k('Неделя, Sonnet'), r.seven_day_sonnet],
    ]
    for (const [label, w] of windows) {
      if (w && typeof w.utilization === 'number') items.push({ label, percent: w.utilization, resetsAt: date(w.resets_at) })
    }
  }
  const rows = (r.seven_day_breakdown?.rows ?? []).filter(x => x.display_name && (x.percent ?? 0) > 0)
  const breakdown = rows.length ? rows.sort((a, b) => b.percent! - a.percent!).map(x => `${x.display_name} ${x.percent}%`).join(', ') : null
  return { items, breakdown }
}

let limitsCache: { at: number; value: Limits | string } | null = null

/** The last limits fetched, however old (for the dashboard: it never fetches itself). */
export function lastLimits(): { at: number; limits: Limits } | null {
  return limitsCache && typeof limitsCache.value !== 'string' ? { at: limitsCache.at, limits: limitsCache.value } : null
}

/** Forget the cached answer (tests, and the watcher wants a fresh one). */
export function resetLimitsCache(): void {
  limitsCache = null
}

/** Limits, or why they are missing. Cached for a minute: /usage pressed twice is one request. */
export async function fetchLimits(o: OAuth | null = readOAuth()): Promise<Limits | string> {
  if (!settings.usageLimits) return tr('отключены (USAGE_LIMITS=off)')
  if (!o?.accessToken) return tr('нет OAuth-токена подписки в .credentials.json')
  if (o.expiresAt && o.expiresAt < Date.now()) return tr('токен истёк, Claude Code обновит его при следующем запросе')
  if (limitsCache && Date.now() - limitsCache.at < 60_000) return limitsCache.value
  let value: Limits | string
  try {
    const res = await fetch(settings.usageApiUrl, {
      headers: { Authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) value = tr('эндпоинт ответил {status}', { status: res.status })
    else {
      const parsed = parseLimits(await res.json() as UsageResponse)
      value = parsed.items.length ? parsed : tr('эндпоинт ответил в незнакомом формате')
    }
  } catch (err) {
    value = tr('эндпоинт недоступен: {v}', { v: String(err instanceof Error ? err.message : err) })
  }
  limitsCache = { at: Date.now(), value }
  return value
}

// --------------------------------------------------------------------------
// Token use from transcripts
// --------------------------------------------------------------------------

/** $ per million tokens: input, output, 5-minute cache write, 1-hour cache write, cache read. */
type Price = [number, number, number, number, number]
const PRICES: [RegExp, Price][] = [
  [/fable-5-1|mythos-5-1/, [10, 50, 12.5, 20, 0.25]],
  [/fable-5|mythos-5/, [10, 50, 12.5, 20, 1]],
  [/opus-5-5/, [4, 20, 5, 8, 0.2]],
  [/opus-(5|4-[5-9])/, [5, 25, 6.25, 10, 0.5]],
  [/sonnet-5/, [2, 10, 2.5, 4, 0.2]],
  [/sonnet-4/, [3, 15, 3.75, 6, 0.3]],
  [/haiku-5-5/, [0.1, 0.5, 0.125, 0.2, 0.01]],
  [/haiku-4-5/, [1, 5, 1.25, 2, 0.1]],
]
/** Claude Haiku 5.5 bills prompts over 100K tokens at the higher card. */
const HAIKU_LONG: Price = [0.5, 2.5, 0.625, 1, 0.05]

export type Entry = {
  /** message id + request id: the same reply can sit in a session's and a subagent's transcript. */
  id: string
  ts: number
  model: string
  input: number
  output: number
  write5m: number
  write1h: number
  read: number
  cwd: string
}

/** Dollars at API rates; null for a model we have no price for. */
export function costOf(e: Entry): number | null {
  let price = PRICES.find(([re]) => re.test(e.model))?.[1]
  if (!price) return null
  if (/haiku-5-5/.test(e.model) && e.input + e.write5m + e.write1h + e.read > 100_000) price = HAIKU_LONG
  const [i, o, w5, w1, r] = price
  return (e.input * i + e.output * o + e.write5m * w5 + e.write1h * w1 + e.read * r) / 1e6
}

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}

/**
 * Assistant replies of one transcript. Claude Code writes a line per content
 * block, each with the same message id and usage: count the message once.
 */
export function parseTranscript(text: string, since: number): Entry[] {
  // The folder the session started in: a later `cd` into a subfolder is the same session.
  const first = /"cwd":("(?:[^"\\]|\\.)*")/.exec(text)
  let root = ''
  try {
    root = first ? JSON.parse(first[1]) : ''
  } catch {}
  const seen = new Map<string, Entry>()
  for (const [n, line] of text.split('\n').entries()) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    let m: { type?: string; timestamp?: string; cwd?: string; requestId?: string; message?: { id?: string; model?: string; usage?: Usage } }
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    const u = m.message?.usage
    const model = m.message?.model
    if (m.type !== 'assistant' || !u || !model || model.startsWith('<')) continue
    const ts = Date.parse(m.timestamp ?? '')
    if (!(ts >= since)) continue
    const created = u.cache_creation_input_tokens ?? 0
    const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const id = m.message?.id ? `${m.message.id}:${m.requestId ?? ''}` : `line:${n}`
    const e: Entry = {
      id, ts, model,
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      write1h: w1,
      write5m: u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? created - w1) : created,
      read: u.cache_read_input_tokens ?? 0,
      cwd: root || (m.cwd ?? ''),
    }
    seen.set(id, e)
  }
  return [...seen.values()]
}

const fileCache = new Map<string, { mtime: number; size: number; entries: Entry[] }>()

function* jsonlFiles(dir: string, depth = 0): Generator<string> {
  let items: string[]
  try {
    items = readdirSync(dir)
  } catch {
    return
  }
  for (const name of items) {
    const p = join(dir, name)
    if (name.endsWith('.jsonl')) yield p
    // <project>/<session>/subagents/agent-*.jsonl
    else if (depth < 3 && !name.includes('.')) yield* jsonlFiles(p, depth + 1)
  }
}

/** Two months and a day: a monthly report compares with the month before. */
const CACHE_DAYS = 64

/** Every reply of the last `days` (< CACHE_DAYS) days across all projects; unchanged files come from the cache. */
export function collectEntries(now = Date.now(), days = 7, configDir = CONFIG_DIR): Entry[] {
  const since = now - days * 86_400_000
  const out = new Map<string, Entry>()
  const alive = new Set<string>()
  for (const file of jsonlFiles(join(configDir, 'projects'))) {
    let st
    try {
      st = statSync(file)
    } catch {
      continue
    }
    if (st.mtimeMs < now - CACHE_DAYS * 86_400_000) continue
    alive.add(file)
    // Nothing in the window, but keep it cached for the longer windows.
    if (st.mtimeMs < since && fileCache.has(file)) continue
    let c = fileCache.get(file)
    if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      // Always CACHE_DAYS, whatever the caller asked: the cached copy serves every window as it slides.
      c = { mtime: st.mtimeMs, size: st.size, entries: parseTranscript(text, now - CACHE_DAYS * 86_400_000) }
      fileCache.set(file, c)
    }
    for (const e of c.entries) if (e.ts >= since) out.set(e.id.startsWith('line:') ? `${file}:${e.id}` : e.id, e)
  }
  for (const f of fileCache.keys()) if (!alive.has(f)) fileCache.delete(f)
  return [...out.values()]
}

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------

export type Sum = { tokens: number; cost: number; unpriced: number }

export function add(s: Sum, e: Entry): void {
  s.tokens += e.input + e.output + e.write5m + e.write1h + e.read
  const c = costOf(e)
  if (c == null) s.unpriced++
  else s.cost += c
}

export function fmtTok(n: number): string {
  if (n >= 1e9) return tr('{v} млрд', { v: (n / 1e9).toFixed(1) })
  if (n >= 1e6) return tr('{v} млн', { v: (n / 1e6).toFixed(1) })
  if (n >= 1e3) return tr('{v} тыс.', { v: Math.round(n / 1e3) })
  return String(n)
}

export function fmtSum(s: Sum): string {
  return tr('{v} ток. · ${v2}{v3}', { v: fmtTok(s.tokens), v2: s.cost.toFixed(2), v3: s.unpriced ? tr(' (+{unpriced} без цены)', { unpriced: s.unpriced }) : '' })
}

/** "сброс в 18:30 (через 2 ч 5 мин)"; without the word: "в 18:30 (через 2 ч 5 мин)". */
export function fmtReset(at: Date, now: number, word = true): string {
  const time = at.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  const sameDay = new Date(now).toDateString() === at.toDateString()
  const when = sameDay ? tr('в {time}', { time }) : tr('{v} в {time}', { v: at.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' }), time })
  const left = Math.max(0, at.getTime() - now)
  const days = Math.floor(left / 86_400_000)
  const vars = { when, v: days ? tr('{days} д {v} ч', { days, v: Math.floor((left % 86_400_000) / 3600_000) }) : fmtDuration(left) }
  return word ? tr('сброс {when} (через {v})', vars) : tr('{when} (через {v})', vars)
}

/** 20 segments, 5% each. */
export function bar(percent: number): string {
  const n = Math.max(0, Math.min(20, Math.round(percent / 5)))
  return '▰'.repeat(n) + '▱'.repeat(20 - n)
}

/** 👤 user, 👑 main or 📂 project — by the folder the reply was made in. */
export function ownerOf(d: Daemon, cwd: string): string {
  if (!cwd) return tr('❔ неизвестно')
  const rel = relative(settings.usersDir, cwd)
  const user = /^(\d+)(\/|$)/.exec(rel)?.[1]
  if (user) return `👤 ${d.userLabel(user)}`
  if (cwd === d.mainKey()) return `👑 ${basename(cwd) || cwd}`
  return `📂 ${basename(cwd) || cwd}`
}

export type Share = { who: string; userId: string | null; cost: number; percent: number }

/**
 * Who spent the 5-hour window: API-price cost since the window began, by
 * person (a user's session) or 📂 projects together, and each one's part of
 * the window's percentage — utilization × their share of the cost. An
 * estimate: the limit itself is not counted in dollars.
 */
export function windowShares(d: Daemon, limits: Limits, entries: Entry[], now = Date.now()): { limit: Limit; shares: Share[] } | null {
  const limit = limits.items.find(l => l.label === LIMIT_LABELS.session)
  if (!limit) return null
  const start = limit.resetsAt ? limit.resetsAt.getTime() - 5 * 3600_000 : now - 5 * 3600_000
  return { limit, shares: sharesSince(d, entries, start, limit.percent) }
}

/** Cost by person since start; percent = scale × their part of the cost (scale 100: share of spending). */
export function sharesSince(d: Daemon, entries: Entry[], start: number, scale = 100): Share[] {
  const by = new Map<string, Share>()
  let total = 0
  for (const e of entries) {
    if (e.ts < start) continue
    const cost = costOf(e) ?? 0
    const userId = /^(\d+)(\/|$)/.exec(relative(settings.usersDir, e.cwd))?.[1] ?? null
    const key = userId ?? 'projects'
    const sh = by.get(key) ?? { who: userId ? `👤 ${d.userLabel(userId)}` : tr('📂 проекты и главная'), userId, cost: 0, percent: 0 }
    sh.cost += cost
    total += cost
    by.set(key, sh)
  }
  if (total <= 0) return []
  return [...by.values()].map(sh => ({ ...sh, percent: scale * sh.cost / total })).sort((a, b) => b.cost - a.cost)
}

/** The period of the «who spends», «by model» and «by session» sections of /usage, chosen with buttons. */
export type Period = 'h5' | 'd' | 'w' | 'm'
export const PERIODS: Period[] = ['h5', 'd', 'w', 'm']
const PERIOD_MS: Record<Period, number> = { h5: 5 * 3600_000, d: 86_400_000, w: 7 * 86_400_000, m: 30 * 86_400_000 }
const PERIOD_NAME: Record<Period, string> = { h5: k('5 часов'), d: k('сутки'), w: k('7 дней'), m: k('30 дней') }
const PERIOD_BUTTON: Record<Period, string> = { h5: k('5 ч'), d: k('День'), w: k('Неделя'), m: k('Месяц') }

export function usagePeriod(d: Daemon): Period {
  const v = d.store.get('usage_period') as Period | null
  return v && PERIODS.includes(v) ? v : 'w'
}

export async function usageReport(d: Daemon, now = Date.now(), period: Period = usagePeriod(d)): Promise<string> {
  const oauth = readOAuth()
  const plan = planName(oauth)
  const out: string[] = [tr('📊 <b>Подписка</b>: {v}', { v: plan ? escapeHtml(plan) : tr('не найдена (вход по API-ключу или учётные данные в keychain)') })]

  const limits = await fetchLimits(oauth)
  if (typeof limits === 'string') out.push(tr('Лимиты: {v}', { v: escapeHtml(limits) }))
  else {
    const lines = limits.items.map(l => `${escapeHtml(tr(l.label))}: <b>${Math.round(l.percent)}%</b> ${bar(l.percent)}${l.resetsAt ? `\n   ${fmtReset(l.resetsAt, now)}` : ''}`)
    if (limits.breakdown) lines.push(tr('За неделю: {v}', { v: escapeHtml(limits.breakdown) }))
    out.push(`<blockquote>${lines.join('\n')}</blockquote>`)
  }

  const entries = collectEntries(now, 31)
  const windows: [string, number][] = [[tr('5 часов'), 5 * 3600_000], [tr('Сутки'), 86_400_000], [tr('7 дней'), 7 * 86_400_000]]
  const sums = windows.map(([label, ms]) => {
    const s: Sum = { tokens: 0, cost: 0, unpriced: 0 }
    for (const e of entries) if (e.ts >= now - ms) add(s, e)
    return `${label}: ${fmtSum(s)}`
  })
  out.push(tr('💸 <b>Потребление</b>, в ценах API\n<blockquote>{v}</blockquote>', { v: sums.join('\n') }))
  if (!entries.length) return out.join('\n\n')
  const since = now - PERIOD_MS[period]
  const name = tr(PERIOD_NAME[period])
  // For 5 hours and a week the share is of the subscription window (its own start), otherwise of the spending.
  const window = typeof limits === 'string' ? null : limits.items.find(l => l.label === (period === 'h5' ? LIMIT_LABELS.session : period === 'w' ? LIMIT_LABELS.weekly_all : ''))
  const windowStart = window?.resetsAt ? window.resetsAt.getTime() - PERIOD_MS[period] : since
  const shares = window ? sharesSince(d, entries, windowStart, window.percent) : sharesSince(d, entries, since)
  if (shares.length) {
    const head = window
      ? tr('👥 <b>Кто тратит окно «{v}»</b> ({v2}%)', { v: escapeHtml(tr(window.label)), v2: Math.round(window.percent) })
      : tr('👥 <b>Кто тратит</b>, {period}', { period: name })
    const line = (sh: Share) => window ? tr('{who}: ≈{p}% окна · ${cost}', { who: escapeHtml(sh.who), p: Math.round(sh.percent), cost: sh.cost.toFixed(2) })
      : tr('{who}: {p}% расхода · ${cost}', { who: escapeHtml(sh.who), p: Math.round(sh.percent), cost: sh.cost.toFixed(2) })
    out.push(`${head}\n<blockquote>${shares.map(line).join('\n')}</blockquote>`)
  }

  const group = (key: (e: Entry) => string) => {
    const m = new Map<string, Sum>()
    for (const e of entries) {
      if (e.ts < since) continue
      const k = key(e)
      const s = m.get(k) ?? { tokens: 0, cost: 0, unpriced: 0 }
      add(s, e)
      m.set(k, s)
    }
    return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens)
  }
  const models = group(e => e.model.replace(/^claude-/, ''))
  const owners = group(e => ownerOf(d, e.cwd))
  const none = tr('ничего')
  out.push(tr('🧠 <b>По моделям</b>, {period}\n<blockquote>{v}</blockquote>', { period: name, v: models.map(([k, s]) => `${escapeHtml(k)}: ${fmtSum(s)}`).join('\n') || none }))
  out.push(tr('🗂 <b>По сессиям</b>, {period}\n<blockquote expandable>{v}</blockquote>', { period: name, v: owners.slice(0, 15).map(([k, s]) => `${escapeHtml(k)}: ${fmtSum(s)}`).join('\n') || none }))
  if (lastLimits()?.limits.items.some(l => l.resetsAt)) out.push(tr('<i>🔔 — напомнить о сбросе окна, 🔕 — то же без звука.</i>'))
  out.push(tr('<i>Стоимость: если бы те же токены шли через API. Подписка оплачивается фиксированно.</i>'))
  return out.join('\n\n')
}

// --------------------------------------------------------------------------
// Limit alerts
// --------------------------------------------------------------------------

type LimitState = { level: number; resetsAt: string | null; notified?: boolean }

/**
 * Tell the owner when a limit crosses an alert threshold, and when a window
 * that was over the first threshold resets. One message per crossing: the
 * reached level is remembered per limit in the store.
 */
export async function checkLimits(d: Daemon, now = Date.now()): Promise<void> {
  const thresholds = settings.limitAlerts
  const to = owner()
  if (!thresholds.length || !to || !settings.usageLimits) return
  if (limitsCache && now - limitsCache.at >= 60_000) limitsCache = null
  const limits = await fetchLimits()
  if (typeof limits === 'string') return
  for (const l of limits.items) {
    const key = `limit:${l.label}`
    const prev: LimitState = JSON.parse(d.store.get(key) ?? '{"level":0,"resetsAt":null}')
    const resetsAt = l.resetsAt?.toISOString() ?? null
    const level = thresholds.filter(t => l.percent >= t).at(-1) ?? 0
    const reset = l.resetsAt ? `\n${fmtReset(l.resetsAt, now)}` : ''
    const newWindow = prev.resetsAt != null && resetsAt != null && Math.abs(Date.parse(prev.resetsAt) - Date.parse(resetsAt)) > 60_000
    // The reset timer (below) already said so, on the minute; this is the fallback if it didn't run.
    if (prev.level > 0 && level === 0 && !prev.notified) {
      await d.bot.api.sendMessage(to, tr('✅ Лимит «{v}» восстановился: {v2}% {v3}', { v: escapeHtml(tr(l.label)), v2: Math.round(l.percent), v3: bar(l.percent) }), { parse_mode: 'HTML' }).catch(err => d.log(`limit notice failed: ${err}`))
    } else if (level > (newWindow ? 0 : prev.level)) {
      const icon = level >= thresholds.at(-1)! ? '🚨' : '⚠️'
      await d.bot.api.sendMessage(to, tr('{icon} Лимит «{v}»: <b>{v2}%</b> {v3}{reset}', { icon, v: escapeHtml(tr(l.label)), v2: Math.round(l.percent), v3: bar(l.percent), reset }), { parse_mode: 'HTML' }).catch(err => d.log(`limit notice failed: ${err}`))
    }
    d.store.set(key, JSON.stringify({ level, resetsAt } satisfies LimitState))
    // Over a threshold: say "tokens are back" exactly when the window resets.
    if (level > 0 && l.resetsAt) scheduleResetNotice(d, l.label, l.resetsAt)
  }
  await checkShares(d, to, limits, now)
  rescheduleRequested(d)
  d.onSessionsChanged()
}

/** USER_SHARE_ALERT: tell the owner once per window when someone else took that much of the 5-hour window. */
async function checkShares(d: Daemon, to: string, limits: Limits, now: number): Promise<void> {
  const pct = settings.userShareAlert
  if (pct <= 0) return
  const ws = windowShares(d, limits, collectEntries(now, 1), now)
  if (!ws) return
  const windowKey = ws.limit.resetsAt?.toISOString() ?? ''
  for (const sh of ws.shares) {
    if (!sh.userId || sh.userId === to || sh.percent < pct) continue
    const key = `share_alert:${sh.userId}`
    if (d.store.get(key) === windowKey) continue
    d.store.set(key, windowKey)
    const reset = ws.limit.resetsAt ? `\n${fmtReset(ws.limit.resetsAt, now)}` : ''
    await d.bot.api.sendMessage(to, tr('👥 {v} израсходовал(а) ≈<b>{v2}%</b> окна «{v3}» (всего занято {v4}%).{reset}', { v: escapeHtml(sh.who), v2: Math.round(sh.percent), v3: escapeHtml(tr(ws.limit.label)), v4: Math.round(ws.limit.percent), reset }), { parse_mode: 'HTML' })
      .catch(err => d.log(`share notice failed: ${err}`))
  }
}

// --------------------------------------------------------------------------
// Reset notices, on the minute
// --------------------------------------------------------------------------

const resetTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * One message to the owner when this window resets (a little after resets_at,
 * so the API already counts the new window). Idempotent per window.
 */
export function scheduleResetNotice(d: Daemon, label: string, resetsAt: Date, now = Date.now()): void {
  const key = `${label}|${resetsAt.toISOString()}`
  if (resetTimers.has(key) || resetsAt.getTime() < now - 60_000) return
  const t = setTimeout(() => void fireResetNotice(d, label, key), Math.max(0, resetsAt.getTime() + 30_000 - now))
  t.unref?.()
  resetTimers.set(key, t)
}

async function fireResetNotice(d: Daemon, label: string, key: string): Promise<void> {
  resetTimers.delete(key)
  const to = owner()
  if (!to) return
  // Asked for in /usage for this window (maybe silently): done now.
  const req = parseRequest(d.store.get(`limit_notify:${label}`))
  const silent = req?.at === key.split('|')[1] && req.silent
  if (req?.at === key.split('|')[1]) d.store.set(`limit_notify:${label}`, null)
  // The 10-minute check would otherwise announce the same reset again.
  d.store.set(`limit:${label}`, JSON.stringify({ level: 0, resetsAt: null, notified: true } satisfies LimitState))
  await d.bot.api.sendMessage(to, tr('✅ Токены обновились: лимит «{v}» сброшен, можно пользоваться.', { v: escapeHtml(tr(label)) }), { parse_mode: 'HTML', disable_notification: silent })
    .catch(err => d.log(`reset notice failed: ${err}`))
}

/** Stored as "<iso>" or "<iso>|silent". */
function parseRequest(raw: string | null): { at: string; silent: boolean } | null {
  if (!raw) return null
  const [at, mode] = raw.split('|')
  return { at, silent: mode === 'silent' }
}

/** "🔔 Напомнить о сбросе" / "🔕 Тихо" in /usage: remembered in the store, so a restart keeps it. */
export function requestResetNotice(d: Daemon, label: string, resetsAt: Date, silent = false): void {
  d.store.set(`limit_notify:${label}`, `${resetsAt.toISOString()}${silent ? '|silent' : ''}`)
  scheduleResetNotice(d, label, resetsAt)
}

function rescheduleRequested(d: Daemon): void {
  // Timers live in memory: after a restart, set again the ones asked for in /usage.
  for (const key of d.store.keys('limit_notify:')) {
    const req = parseRequest(d.store.get(key))
    if (req) scheduleResetNotice(d, key.slice('limit_notify:'.length), new Date(req.at))
  }
}

/** Under /usage: per limit, a reminder with sound and a silent one; ✅ marks what was asked. */
export function usageKeyboard(d: Daemon): InlineKeyboard {
  const l = lastLimits()
  const period = usagePeriod(d)
  const rows: ReturnType<typeof button>[][] = [
    PERIODS.map(p => button(`${p === period ? '• ' : ''}${tr(PERIOD_BUTTON[p])}`, `us:p:${p}`, p === period ? 'primary' : undefined)),
  ]
  // Short labels: a phone shows about 15 characters of a half-width button.
  for (const [i, it] of (l?.limits.items ?? []).entries()) {
    if (!it.resetsAt) continue
    const req = parseRequest(d.store.get(`limit_notify:${it.label}`))
    const asked = req?.at === it.resetsAt.toISOString() ? req : null
    rows.push([
      button(`${asked && !asked.silent ? '✅' : '🔔'} ${tr(it.label)}`, `lr:${i}`),
      button(`${asked?.silent ? '✅' : '🔕'} ${tr(it.label)}`, `lr:${i}:s`),
    ])
  }
  rows.push([button(tr('« Статистика'), 'hub:stats')])
  return new InlineKeyboard(rows)
}

/** lr:<n>[:s] — remind about the reset of limit n (silently); us:p:<period> — the period of /usage sections. */
export async function handleResetCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const p = /^us:p:(h5|d|w|m)$/.exec(data)
  const m = /^lr:(\d+)(:s)?$/.exec(data)
  if (!m && !p) return false
  if (!ctx.from || String(ctx.from.id) !== owner()) {
    await ctx.answerCallbackQuery({ text: tr('Только для владельца подписки.') }).catch(() => {})
    return true
  }
  if (p) {
    d.store.set('usage_period', p[1])
    await ctx.answerCallbackQuery({ text: tr('📊 Собираю…') }).catch(() => {})
    await ctx.editMessageText(await usageReport(d), { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: usageKeyboard(d) })
      .catch(err => { if (!isMessageNotModified(err)) d.log(`usage period: ${err}`) })
    return true
  }
  if (!m) return true
  const it = lastLimits()?.limits.items[Number(m[1])]
  if (!it?.resetsAt) {
    await ctx.answerCallbackQuery({ text: tr('Данные о лимитах устарели — откройте /usage заново.') }).catch(() => {})
    return true
  }
  const silent = !!m[2]
  requestResetNotice(d, it.label, it.resetsAt, silent)
  await ctx.answerCallbackQuery({ text: `${silent ? tr('🔕 Тихо напомню') : tr('🔔 Напомню')} ${fmtReset(it.resetsAt, Date.now(), false)}` }).catch(() => {})
  await ctx.editMessageReplyMarkup({ reply_markup: usageKeyboard(d) }).catch(() => {})
  return true
}

export function startLimitWatch(d: Daemon): void {
  rescheduleRequested(d)
  const min = settings.limitCheckMin
  if (min <= 0) return
  const tick = () => void checkLimits(d).catch(err => d.log(`limit check failed: ${err}`))
  setTimeout(tick, 15_000).unref?.()
  setInterval(tick, min * 60_000).unref?.()
}

/** "📊 5 часов 42% · Неделя 31%" for the pinned dashboard; null before the first fetch. */
export function limitsLine(): string | null {
  const l = lastLimits()
  if (!l || !l.limits.items.length) return null
  return '📊 ' + l.limits.items.map(i => `${tr(i.label)} ${Math.round(i.percent)}%`).join(' · ')
}

// --------------------------------------------------------------------------
// Per-session cost and the daily digest
// --------------------------------------------------------------------------

function startOfDay(now: number): number {
  const t = new Date(now)
  t.setHours(0, 0, 0, 0)
  return t.getTime()
}

/** "💸 сегодня $1.23 · 4.5 млн ток." for a session card; null before its first reply today. */
export function sessionCostLine(s: Session, now = Date.now()): string | null {
  const since = startOfDay(now)
  const sum: Sum = { tokens: 0, cost: 0, unpriced: 0 }
  for (const e of collectEntries(now, 1)) if (e.ts >= since && (e.cwd === s.cwd || e.cwd === s.projectKey)) add(sum, e)
  return sum.tokens ? tr('💸 сегодня ${v} · {v2} ток.', { v: sum.cost.toFixed(2), v2: fmtTok(sum.tokens) }) : null
}

/** What happened today: spend by session and commits per project folder. */
export async function digestReport(d: Daemon, now = Date.now()): Promise<string> {
  const since = startOfDay(now)
  const entries = collectEntries(now, 1).filter(e => e.ts >= since)
  const total: Sum = { tokens: 0, cost: 0, unpriced: 0 }
  const byFolder = new Map<string, Sum>()
  for (const e of entries) {
    add(total, e)
    const sum = byFolder.get(e.cwd) ?? { tokens: 0, cost: 0, unpriced: 0 }
    add(sum, e)
    byFolder.set(e.cwd, sum)
  }
  const folders = new Set([...byFolder.keys(), ...d.activeSessions().map(s => s.projectKey)].filter(Boolean))
  const date = new Date(now).toLocaleDateString(locale(), { day: 'numeric', month: 'long' })
  const out = [tr('🌙 <b>Итоги дня</b> · {date}', { date }), tr('💸 {v} в ценах API', { v: fmtSum(total) })]
  const rows: { cost: number; text: string }[] = []
  for (const dir of folders) {
    const sum = byFolder.get(dir)
    const commits = await commitsSince(dir, new Date(since))
    if (!sum && !commits?.length) continue
    const lines = [`${ownerOf(d, dir)}${sum ? ` · $${sum.cost.toFixed(2)}` : ''}${commits?.length ? tr(' · коммитов {length}', { length: commits.length }) : ''}`]
    for (const c of (commits ?? []).slice(0, 3)) lines.push(`   • ${escapeHtml(c.length > 80 ? c.slice(0, 79) + '…' : c)}`)
    if ((commits?.length ?? 0) > 3) lines.push(tr('   … ещё {v}', { v: commits!.length - 3 }))
    rows.push({ cost: sum?.cost ?? 0, text: lines.join('\n') })
  }
  rows.sort((a, b) => b.cost - a.cost)
  out.push(rows.length ? rows.map(r => r.text).join('\n') : tr('Сегодня сессии ничего не делали.'))
  const limits = limitsLine()
  if (limits) out.push(limits)
  return out.join('\n\n')
}

/** Send the digest once a day at DIGEST_AT (checked every minute). */
export function startDigest(d: Daemon): void {
  setInterval(() => {
    const at = settings.digestAt
    const to = owner()
    if (!at || !to) return
    const now = new Date()
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const key = `digest:${now.toDateString()}`
    if (hm < at || d.store.get(key)) return
    d.store.set(key, '1')
    void digestReport(d).then(text => d.bot.api.sendMessage(to, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }))
      .catch(err => d.log(`digest failed: ${err}`))
  }, 60_000).unref?.()
}
