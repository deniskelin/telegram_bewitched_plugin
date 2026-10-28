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
import { owner } from '../access.ts'
import type { Daemon, Session } from './daemon.ts'
import { commitsSince } from './git.ts'

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
  session: '5 часов',
  weekly_all: 'Неделя',
  weekly_opus: 'Неделя, Opus',
  weekly_sonnet: 'Неделя, Sonnet',
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
      ['5 часов', r.five_hour], ['Неделя', r.seven_day], ['Неделя, Opus', r.seven_day_opus], ['Неделя, Sonnet', r.seven_day_sonnet],
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
  if (!settings.usageLimits) return 'отключены (USAGE_LIMITS=off)'
  if (!o?.accessToken) return 'нет OAuth-токена подписки в .credentials.json'
  if (o.expiresAt && o.expiresAt < Date.now()) return 'токен истёк, Claude Code обновит его при следующем запросе'
  if (limitsCache && Date.now() - limitsCache.at < 60_000) return limitsCache.value
  let value: Limits | string
  try {
    const res = await fetch(settings.usageApiUrl, {
      headers: { Authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) value = `эндпоинт ответил ${res.status}`
    else {
      const parsed = parseLimits(await res.json() as UsageResponse)
      value = parsed.items.length ? parsed : 'эндпоинт ответил в незнакомом формате'
    }
  } catch (err) {
    value = `эндпоинт недоступен: ${err instanceof Error ? err.message : err}`
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
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} млрд`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} млн`
  if (n >= 1e3) return `${Math.round(n / 1e3)} тыс.`
  return String(n)
}

export function fmtSum(s: Sum): string {
  return `${fmtTok(s.tokens)} ток. · $${s.cost.toFixed(2)}${s.unpriced ? ` (+${s.unpriced} без цены)` : ''}`
}

export function fmtReset(at: Date, now: number): string {
  const time = at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const sameDay = new Date(now).toDateString() === at.toDateString()
  const when = sameDay ? `в ${time}` : `${at.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} в ${time}`
  const left = Math.max(0, at.getTime() - now)
  const days = Math.floor(left / 86_400_000)
  return `сброс ${when} (через ${days ? `${days} д ${Math.floor((left % 86_400_000) / 3600_000)} ч` : fmtDuration(left)})`
}

export function bar(percent: number): string {
  const n = Math.max(0, Math.min(10, Math.round(percent / 10)))
  return '▰'.repeat(n) + '▱'.repeat(10 - n)
}

/** 👤 user, 👑 main or 📂 project — by the folder the reply was made in. */
export function ownerOf(d: Daemon, cwd: string): string {
  if (!cwd) return '❔ неизвестно'
  const rel = relative(settings.usersDir, cwd)
  const user = /^(\d+)(\/|$)/.exec(rel)?.[1]
  if (user) return `👤 ${d.userLabel(user)}`
  if (cwd === d.mainKey()) return `👑 ${basename(cwd) || cwd}`
  return `📂 ${basename(cwd) || cwd}`
}

export async function usageReport(d: Daemon, now = Date.now()): Promise<string> {
  const oauth = readOAuth()
  const plan = planName(oauth)
  const out: string[] = [`📊 <b>Подписка</b>: ${plan ? escapeHtml(plan) : 'не найдена (вход по API-ключу или учётные данные в keychain)'}`]

  const limits = await fetchLimits(oauth)
  if (typeof limits === 'string') out.push(`Лимиты: ${escapeHtml(limits)}`)
  else {
    const lines = limits.items.map(l => `${escapeHtml(l.label)}: <b>${Math.round(l.percent)}%</b> ${bar(l.percent)}${l.resetsAt ? `\n   ${fmtReset(l.resetsAt, now)}` : ''}`)
    if (limits.breakdown) lines.push(`За неделю: ${escapeHtml(limits.breakdown)}`)
    out.push(`<blockquote>${lines.join('\n')}</blockquote>`)
  }

  const entries = collectEntries(now)
  const windows: [string, number][] = [['5 часов', 5 * 3600_000], ['Сутки', 86_400_000], ['7 дней', 7 * 86_400_000]]
  const sums = windows.map(([label, ms]) => {
    const s: Sum = { tokens: 0, cost: 0, unpriced: 0 }
    for (const e of entries) if (e.ts >= now - ms) add(s, e)
    return `${label}: ${fmtSum(s)}`
  })
  out.push(`💸 <b>Потребление</b>, в ценах API\n<blockquote>${sums.join('\n')}</blockquote>`)
  if (!entries.length) return out.join('\n\n')

  const group = (key: (e: Entry) => string) => {
    const m = new Map<string, Sum>()
    for (const e of entries) {
      const k = key(e)
      const s = m.get(k) ?? { tokens: 0, cost: 0, unpriced: 0 }
      add(s, e)
      m.set(k, s)
    }
    return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens)
  }
  const models = group(e => e.model.replace(/^claude-/, ''))
  const owners = group(e => ownerOf(d, e.cwd))
  out.push(`🧠 <b>По моделям</b>, 7 дней\n<blockquote>${models.map(([k, s]) => `${escapeHtml(k)}: ${fmtSum(s)}`).join('\n')}</blockquote>`)
  out.push(`🗂 <b>По сессиям</b>, 7 дней\n<blockquote expandable>${owners.slice(0, 15).map(([k, s]) => `${escapeHtml(k)}: ${fmtSum(s)}`).join('\n')}</blockquote>`)
  out.push('<i>Стоимость: если бы те же токены шли через API. Подписка оплачивается фиксированно.</i>')
  return out.join('\n\n')
}

// --------------------------------------------------------------------------
// Limit alerts
// --------------------------------------------------------------------------

type LimitState = { level: number; resetsAt: string | null }

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
    if (prev.level > 0 && level === 0) {
      await d.bot.api.sendMessage(to, `✅ Лимит «${escapeHtml(l.label)}» восстановился: ${Math.round(l.percent)}% ${bar(l.percent)}`, { parse_mode: 'HTML' }).catch(err => d.log(`limit notice failed: ${err}`))
    } else if (level > (newWindow ? 0 : prev.level)) {
      const icon = level >= thresholds.at(-1)! ? '🚨' : '⚠️'
      await d.bot.api.sendMessage(to, `${icon} Лимит «${escapeHtml(l.label)}»: <b>${Math.round(l.percent)}%</b> ${bar(l.percent)}${reset}`, { parse_mode: 'HTML' }).catch(err => d.log(`limit notice failed: ${err}`))
    }
    d.store.set(key, JSON.stringify({ level, resetsAt } satisfies LimitState))
  }
  d.onSessionsChanged()
}

export function startLimitWatch(d: Daemon): void {
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
  return '📊 ' + l.limits.items.map(i => `${i.label} ${Math.round(i.percent)}%`).join(' · ')
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
  return sum.tokens ? `💸 сегодня $${sum.cost.toFixed(2)} · ${fmtTok(sum.tokens)} ток.` : null
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
  const date = new Date(now).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  const out = [`🌙 <b>Итоги дня</b> · ${date}`, `💸 ${fmtSum(total)} в ценах API`]
  const rows: { cost: number; text: string }[] = []
  for (const dir of folders) {
    const sum = byFolder.get(dir)
    const commits = await commitsSince(dir, new Date(since))
    if (!sum && !commits?.length) continue
    const lines = [`${ownerOf(d, dir)}${sum ? ` · $${sum.cost.toFixed(2)}` : ''}${commits?.length ? ` · коммитов ${commits.length}` : ''}`]
    for (const c of (commits ?? []).slice(0, 3)) lines.push(`   • ${escapeHtml(c.length > 80 ? c.slice(0, 79) + '…' : c)}`)
    if ((commits?.length ?? 0) > 3) lines.push(`   … ещё ${commits!.length - 3}`)
    rows.push({ cost: sum?.cost ?? 0, text: lines.join('\n') })
  }
  rows.sort((a, b) => b.cost - a.cost)
  out.push(rows.length ? rows.map(r => r.text).join('\n') : 'Сегодня сессии ничего не делали.')
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
