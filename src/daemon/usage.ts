import { totalText } from './analytics.ts'
import { observeQuota } from './quotahistory.ts'
import { analyticsRange, type RangeMode, type Range } from '../core/analytics.ts'
import { analyticsContent, exportStats, csvStats } from './analytics-ui.ts'
import { bucketStats, freezeAnalytics } from './analytics.ts'
import { columnChartSvg, svgToPng } from './chart.ts'
import { openaiCost } from '../core/openai-pricing.ts'
import { htmlPages } from '../core/html-pages.ts'
import { newUsageViewId, saveUsageView, loadUsageView, viewScope, ownsUsageView, lockUsageView, type UsageView } from './usageview.ts'
/**
 * /usage: the subscription plan (from Claude Code's credentials file), its
 * limits (percent used and reset time, from the same undocumented endpoint
 * Claude Code's /usage calls) and token use counted from all transcripts,
 * priced at API rates.
 */

import { execFile } from 'child_process'
import { readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join, relative } from 'path'
import { CONFIG_DIR, settings } from '../config.ts'
import { escapeHtml, fmtDuration } from '../format.ts'
import { InlineKeyboard, InputFile, type Context } from 'grammy'
import { owner } from '../access.ts'
import { button } from './stream.ts'
import { isMessageNotModified } from '../tg.ts'
import type { Daemon, Session } from './daemon.ts'
import { locale, k, t as tr } from '../i18n/index.ts'
import { noticeTarget, sendNotice } from './journal.ts'
import { inChat } from './lang.ts'
import { savedLine } from './shortcuts.ts'
import { collectCodex, type CodexLimits } from './codexusage.ts'
import { effortLabel, engineOf } from './engines.ts'

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

export type Limit = { label: string; percent: number; resetsAt: Date | null; stale?: boolean; observedAt?: number }
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

const EFFORT = /^[a-z]{1,12}$/

export type Entry = {
  /** message id + request id: the same reply can sit in a session's and a subagent's transcript. */
  id: string
  ts: number
  model: string
  /** Reasoning effort of the request (low … max), when the transcript has it. */
  effort?: string
  serviceTier?: string
  input: number
  output: number
  /** Subset of output, when the CLI exposes it. */
  reasoning?: number
  tasks?: string[]
  agent?: string
  write5m: number
  write1h: number
  read: number
  cwd: string
}

/** A request's model as shown everywhere: without «claude-», with its reasoning effort — «opus-5-5 · высокий». */
export function modelKey(e: Pick<Entry, 'model' | 'effort'>): string {
  return e.model.replace(/^claude-/, '') + (e.effort ? ` · ${effortLabel(e.effort)}` : '')
}

/** Dollars at API rates; null for a model we have no price for. */
export function costOf(e: Entry): number | null {
  if (/^gpt-|^codex-/.test(e.model)) return openaiCost(e)
  let price = PRICES.find(([re]) => re.test(e.model))?.[1]
  if (!price) return null
  if (/haiku-5-5/.test(e.model) && e.input + e.write5m + e.write1h + e.read > 100_000) price = HAIKU_LONG
  const [i, o, w5, w1, r] = price
  return (e.input * i + e.output * o + e.write5m * w5 + e.write1h * w1 + e.read * r) / 1e6
}

/** Task IDs are bridge metadata in an actual user prompt, not timestamps. */
export function taskMarkers(text: string): string[] {
  return [...new Set([...text.matchAll(/<channel\b[^>]*\btask_ids?="([0-9a-f,]+)"/g)].flatMap(m => m[1]!.split(',')))].filter(id => /^[0-9a-f]{16}$/.test(id))
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
  let tasks: string[] | undefined
  for (const [n, line] of text.split('\n').entries()) {
    if (line.includes('"user"')) {
      try { const event = JSON.parse(line); if (event.type === 'user' && !event.isMeta && !JSON.stringify(event.message?.content).includes('tool_result')) { const text = typeof event.message?.content === 'string' ? event.message.content : (event.message?.content ?? []).filter((x: {type: string}) => x.type === 'text').map((x: {text: string}) => x.text).join('\n'); tasks = taskMarkers(text) } } catch {}
    }
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    let m: { type?: string; timestamp?: string; cwd?: string; requestId?: string; effort?: string; message?: { id?: string; model?: string; usage?: Usage } }
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
      id, ts, model, ...(tasks ? { tasks } : {}),
      ...(typeof m.effort === 'string' && EFFORT.test(m.effort) ? { effort: m.effort } : {}),
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
    for (const e of c.entries) if (e.ts >= since) out.set(e.id.startsWith('line:') ? `${file}:${e.id}` : e.id, e.id.startsWith('line:') ? {...e,id:`${file}:${e.id}`} : e)
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

/** Tokens-only display for unavailable prices. */
function fmtTokens(s: Sum): string {
  return tr('{v} ток.', { v: fmtTok(s.tokens) })
}

/** A sum of mixed engines: tokens only when nothing in it has a price. */
function fmtAny(s: Sum): string {
  return s.cost === 0 && s.unpriced > 0 ? fmtTokens(s) : fmtSum(s)
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

/** 👤 user or 📂 project — by the folder the reply was made in. */
export function ownerOf(d: Daemon, cwd: string): string {
  if (!cwd) return tr('❔ неизвестно')
  const rel = relative(settings.usersDir, cwd)
  const user = /^(\d+)(\/|$)/.exec(rel)?.[1]
  if (user) return `👤 ${d.userLabel(user)}`
  return `📂 ${basename(cwd) || cwd}`
}

export type Share = { who: string; userId: string | null; cost: number; tokens: number; percent: number }

/**
 * Who spent the 5-hour window: API-price cost since the window began, by
 * person (a user's session) or 📂 projects together, and each one's part of
 * the window's percentage — utilization × their share of the cost. An
 * estimate: the limit itself is not counted in dollars.
 */
export function windowShares(d: Daemon, limits: Limits, entries: Entry[], now = Date.now()): { limit: Limit; shares: Share[] } | null {
  const limit = limits.items.find(l => l.label === LIMIT_LABELS.session)
  if(!limit||limit.resetsAt&&limit.resetsAt.getTime()<=now)return null
  const start = limit.resetsAt ? limit.resetsAt.getTime() - 5 * 3600_000 : now - 5 * 3600_000
  return { limit, shares: sharesSince(d, entries, start, 100, 'tokens') }
}

/** Cost by person since start; percent = scale × their part of the cost (scale 100: share of spending). */
export function sharesSince(d: Daemon, entries: Entry[], start: number, scale = 100, by: 'cost' | 'tokens' = 'cost'): Share[] {
  const groups = new Map<string, Share>()
  let total = 0
  for (const e of entries) {
    if (e.ts < start) continue
    const cost = costOf(e) ?? 0
    const tokens = e.input + e.output + e.write5m + e.write1h + e.read
    const userId = /^(\d+)(\/|$)/.exec(relative(settings.usersDir, e.cwd))?.[1] ?? null
    const key = userId ?? 'projects'
    const sh = groups.get(key) ?? { who: userId ? `👤 ${d.userLabel(userId)}` : tr('📂 проекты'), userId, cost: 0, tokens: 0, percent: 0 }
    sh.cost += cost
    sh.tokens += tokens
    total += by === 'cost' ? cost : tokens
    groups.set(key, sh)
  }
  if (total <= 0) return []
  return [...groups.values()].map(sh => ({ ...sh, percent: scale * (by === 'cost' ? sh.cost : sh.tokens) / total })).sort((a, b) => by === 'cost' ? b.cost - a.cost : b.tokens - a.tokens)
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
  const range=analyticsRange(period,'rolling',now,Intl.DateTimeFormat().resolvedOptions().timeZone)
  const content=await analyticsContent(d,range,planName(readOAuth()))
  return content.sections.details!.join('\n\n')
}

/** A limit's name inside its subscription's section: «Codex: 5 часов» → «5 часов». */
function shortLabel(label: string): string {
  return tr(label).replace(/^Codex:\s*/, '')
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
  if (!to || !settings.usageLimits || (!thresholds.length && !warmupOn(d))) return
  if (limitsCache && now - limitsCache.at >= 60_000) limitsCache = null
  // Codex's windows (from its own logs) cross the same thresholds; its alerts have no 🔔 buttons.
  if (thresholds.length) await checkCodexLimits(d, thresholds, now)
  const limits = await fetchLimits()
  if (typeof limits === 'string') return
  for(const l of limits.items)observeQuota(d,'claude',l,lastLimits()?.at??now,now)
  // ⚡ Start the next 5-hour window right at its reset.
  const session = limits.items.find(l => l.label === LIMIT_LABELS.session)
  if (warmupOn(d) && session?.resetsAt) scheduleWarmup(d, session.resetsAt, now)
  if (!thresholds.length) return
  for (const [i, l] of limits.items.entries()) {
    if(l.resetsAt&&l.resetsAt.getTime()<=now)continue
    const key = `limit:${l.label}`
    const prev: LimitState = JSON.parse(d.store.get(key) ?? '{"level":0,"resetsAt":null}')
    const resetsAt = l.resetsAt?.toISOString() ?? null
    const level = thresholds.filter(t => l.percent >= t).at(-1) ?? 0
    const newWindow = prev.resetsAt != null && resetsAt != null && Math.abs(Date.parse(prev.resetsAt) - Date.parse(resetsAt)) > 60_000
    // The reset timer (below) already said so, on the minute; this is the fallback if it didn't run.
    if (prev.level > 0 && level === 0 && !prev.notified) {
      await sendNotice(d, 'limits', () => tr('✅ Лимит «{v}» восстановился: {v2}% {v3}', { v: escapeHtml(tr(l.label)), v2: Math.round(l.percent), v3: bar(l.percent) }))
    } else if (level > (newWindow ? 0 : prev.level)) {
      await sendNotice(d, 'limits', () => alertText(l, level, now), () => ({ reply_markup: alertKb(i) }))
    }
    d.store.set(key, JSON.stringify({ level, resetsAt } satisfies LimitState))
    // Over a threshold: say "tokens are back" exactly when the window resets.
    if (level > 0 && l.resetsAt) scheduleResetNotice(d, l.label, l.resetsAt)
  }
  await checkShares(d, to, limits, now)
  rescheduleRequested(d)
  d.onSessionsChanged()
}

async function checkCodexLimits(d: Daemon, thresholds: number[], now: number): Promise<void> {
  for (const l of freshCodexLimits(collectCodex(now, 31).limits, now)) {
    if(l.stale) continue
    observeQuota(d,'codex',l,l.observedAt??now,now)
    const key = `limit:${l.label}`
    const prev: LimitState = JSON.parse(d.store.get(key) ?? '{"level":0,"resetsAt":null}')
    const resetsAt = l.resetsAt?.toISOString() ?? null
    const level = thresholds.filter(t => l.percent >= t).at(-1) ?? 0
    const newWindow = prev.resetsAt != null && resetsAt != null && Math.abs(Date.parse(prev.resetsAt) - Date.parse(resetsAt)) > 60_000
    if (prev.level > 0 && level === 0 && !prev.notified) {
      await sendNotice(d, 'limits', () => tr('✅ Лимит «{v}» восстановился: {v2}% {v3}', { v: escapeHtml(tr(l.label)), v2: Math.round(l.percent), v3: bar(l.percent) }))
    } else if (level > (newWindow ? 0 : prev.level)) {
      d.log(`codex limit ${l.label}: ${Math.round(l.percent)}% crossed ${level}%`)
      await sendNotice(d, 'limits', () => alertText(l, level, now))
    }
    d.store.set(key, JSON.stringify({ level, resetsAt } satisfies LimitState))
    if (level > 0 && l.resetsAt) scheduleResetNotice(d, l.label, l.resetsAt)
  }
}

function alertText(l: Limit, level: number, now: number): string {
  const icon = level >= (settings.limitAlerts.at(-1) ?? 100) ? '🚨' : level > 0 ? '⚠️' : '✅'
  const reset = l.resetsAt ? `\n${fmtReset(l.resetsAt, now)}` : ''
  return tr('{icon} Лимит «{v}»: <b>{v2}%</b> {v3}{reset}', { icon, v: escapeHtml(tr(l.label)), v2: Math.round(l.percent), v3: bar(l.percent), reset })
}

/** 🔄 refresh the numbers in place, ✖️ delete the notice. */
function alertKb(i: number): InlineKeyboard {
  return new InlineKeyboard([[button(tr('🔄 Обновить'), `la:r:${i}`), button(tr('✖️ Удалить'), 'la:x')]])
}

// --------------------------------------------------------------------------
// ⚡ Start the next 5-hour window right at its reset
// --------------------------------------------------------------------------

/**
 * The 5-hour window starts with the first request after a reset. Sending a
 * tiny one right at the reset starts it then, not when work resumes hours
 * later: the window ends sooner, and the tokens left before a reset can be
 * spent knowing a fresh window is minutes away. Off by default (LIMIT_WARMUP
 * or the ⚡ button in /usage).
 */
export function warmupOn(d: Daemon): boolean {
  const v = d.store.get('limit_warmup')
  return v != null ? v === 'on' : settings.limitWarmup
}

/** The tiny request: one-word answer from the smallest model, via Claude Code (the subscription). Replaced in tests. */
export let runWarmup = (): Promise<void> => new Promise((res, rej) => execFile(settings.claudeBin, ['-p', '--model', 'haiku', 'Reply with one word: ok'],
  { cwd: homedir(), timeout: 120_000, env: { ...process.env, TMUX_PANE: '' } }, err => (err ? rej(err) : res())))
export function setRunWarmup(f: () => Promise<void>): void {
  runWarmup = f
}

/**
 * One window, one key: resets_at comes back a few hundred ms apart between
 * calls (16:19:59.8, then 16:20:00.1), and keyed by the exact time every
 * check scheduled one more timer — six «tokens are back» at one reset.
 */
export function windowKey(at: Date): string {
  return new Date(Math.round(at.getTime() / 60_000) * 60_000).toISOString()
}

const warmupTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function scheduleWarmup(d: Daemon, resetsAt: Date, now = Date.now()): void {
  const key = windowKey(resetsAt)
  if (warmupTimers.has(key) || resetsAt.getTime() < now - 60_000) return
  // A minute after resets_at: the API counts the new window by then.
  const t = setTimeout(() => void fireWarmup(d, key), Math.max(0, resetsAt.getTime() + 60_000 - now))
  t.unref?.()
  warmupTimers.set(key, t)
}

export async function fireWarmup(d: Daemon, key: string): Promise<void> {
  warmupTimers.delete(key)
  if (!warmupOn(d) || d.store.get('limit_warmup_done') === key) return
  d.store.set('limit_warmup_done', key)
  try {
    await runWarmup()
    d.log('limit warmup: the 5-hour window started')
    const ends = new Date(Date.now() + 5 * 3600_000).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
    await sendNotice(d, 'limits', () => tr('⚡ Новое окно «5 часов» запущено сразу после сброса — следующий сброс около {time}.', { time: ends }), () => ({ parse_mode: undefined, disable_notification: true }))
  } catch (err) {
    d.log(`limit warmup failed: ${err}`)
    await sendNotice(d, 'limits', () => tr('⚠️ Не удалось запустить окно после сброса: {err}', { err: escapeHtml(String(err instanceof Error ? err.message : err)).slice(0, 300) }), () => ({ disable_notification: true }))
  }
}

/** USER_SHARE_ALERT: tell the owner once per window when someone else took that much of the 5-hour window. */
async function checkShares(d: Daemon, to: string, limits: Limits, now: number): Promise<void> {
  const pct = settings.userShareAlert
  if (pct <= 0) return
  const ws = windowShares(d, limits, collectEntries(now, 1), now)
  if (!ws) return
  const winKey = ws.limit.resetsAt ? windowKey(ws.limit.resetsAt) : ''
  for (const sh of ws.shares) {
    if (!sh.userId || sh.userId === to || sh.percent < pct) continue
    const key = `share_alert:${sh.userId}`
    if (d.store.get(key) === winKey) continue
    d.store.set(key, winKey)
    const reset = ws.limit.resetsAt ? `\n${fmtReset(ws.limit.resetsAt, now)}` : ''
    await sendNotice(d, 'limits', () => tr('👥 {v}: <b>{v2}%</b> наблюдаемых токенов окна «{v3}»; общий лимит использован на {v4}%.{reset}', { v: escapeHtml(sh.who), v2: Math.round(sh.percent), v3: escapeHtml(tr(ws.limit.label)), v4: Math.round(ws.limit.percent), reset }))
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
  const key = `${label}|${windowKey(resetsAt)}`
  if (resetTimers.has(key) || resetsAt.getTime() < now - 60_000) return
  const t = setTimeout(() => void fireResetNotice(d, label, key), Math.max(0, resetsAt.getTime() + 30_000 - now))
  t.unref?.()
  resetTimers.set(key, t)
}

async function fireResetNotice(d: Daemon, label: string, key: string): Promise<void> {
  resetTimers.delete(key)
  // A reminder the owner asked for in /usage: their DM, not the journal.
  const to = owner()
  if (!to) return
  // Once per window, whatever timers there were.
  if (d.store.get(`limit_reset_done:${label}`) === key) return
  d.store.set(`limit_reset_done:${label}`, key)
  // Asked for in /usage for this window (maybe silently): done now.
  const req = parseRequest(d.store.get(`limit_notify:${label}`))
  const mine = req != null && windowKey(new Date(req.at)) === key.split('|')[1]
  const silent = mine && req.silent
  if (mine) d.store.set(`limit_notify:${label}`, null)
  // «выкл» in /usage: no notice for this window.
  // The 10-minute check would otherwise announce the same reset again.
  d.store.set(`limit:${label}`, JSON.stringify({ level: 0, resetsAt: null, notified: true } satisfies LimitState))
  if (mine && req.off) return
  await d.bot.api.sendMessage(to, tr('Наступило время сброса «{v}». Проверьте актуальные лимиты.', { v: escapeHtml(tr(label)) }), { parse_mode: 'HTML', disable_notification: silent })
    .catch(err => d.log(`reset notice failed: ${err}`))
}

/** Stored as "<iso>", "<iso>|silent" or "<iso>|off". */
function parseRequest(raw: string | null): { at: string; silent: boolean; off: boolean } | null {
  if (!raw) return null
  const [at, mode] = raw.split('|')
  return { at, silent: mode === 'silent', off: mode === 'off' }
}

/** "🔔 Напомнить о сбросе" / "🔕 Тихо" in /usage: remembered in the store, so a restart keeps it. */
export function requestResetNotice(d: Daemon, label: string, resetsAt: Date, silent = false, off = false): void {
  d.store.set(`limit_notify:${label}`, `${windowKey(resetsAt)}${off ? '|off' : silent ? '|silent' : ''}`)
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
/** One screen is a frozen report snapshot; changing its period does not change other screens. */
export async function usageScreen(d: Daemon, c:{chatId:string;threadId?:number},period=usagePeriod(d),now=Date.now(),mode:RangeMode='current',fixedRange?:Range,initialSection='summary'):Promise<{text:string;kb:InlineKeyboard}>{
  const range=fixedRange??analyticsRange(period,mode,now,Intl.DateTimeFormat().resolvedOptions().timeZone)
  const content=await analyticsContent(d,range,planName(readOAuth()))
  const category=initialSection==='limits'?'limits':'usage'
  if(category==='limits'){content.sections.summary=content.sections.quota!;initialSection='summary'}
  const v:UsageView={category,id:newUsageViewId(d),chatId:c.chatId,threadId:c.threadId,period,mode:range.mode,range,stats:freezeAnalytics(content.stats),section:initialSection,sections:content.sections,page:0,pages:content.sections[initialSection]??content.sections.summary!,at:now,limits:content.limits,fixedRange:!!fixedRange}
  saveUsageView(d,v);return renderUsageView(d,v)
}
export function renderUsageView(d:Daemon,v:UsageView):{text:string;kb:InlineKeyboard}{
  return{text:(v.page?tr('📊 <b>Подписки и расход</b>')+'\n\n':'')+v.pages[v.page]!+(v.pages.length>1?`\n\n<i>${tr('Страница {page} из {total}',{page:v.page+1,total:v.pages.length})}</i>`:''),kb:usageKeyboard(d,v)}
}

export function usageKeyboard(d: Daemon, view?: UsageView): InlineKeyboard {
  if(view?.sections&&(view.section??'summary')==='summary')return new InlineKeyboard([[button(tr('Подробнее'),`uv:${view.id}:s:details`),button(tr('Закрыть отчёт'),`uv:${view.id}:x`)]])
  const l = lastLimits()
  const period = view?.period ?? usagePeriod(d)
  const rows: ReturnType<typeof button>[][] = [
    PERIODS.map(p => button(`${p === period ? '• ' : ''}${tr(PERIOD_BUTTON[p])}`, view ? `uv:${view.id}:p:${p}` : `us:p:${p}`, p === period ? 'primary' : undefined)),
  ]
  if (view && view.pages.length > 1) rows.unshift([
    ...(view.page > 0 ? [button('◀', `uv:${view.id}:g:${view.page - 1}`)] : []),
    button(`${view.page + 1}/${view.pages.length}`, `uv:${view.id}:g:${view.page}`),
    ...(view.page + 1 < view.pages.length ? [button('▶', `uv:${view.id}:g:${view.page + 1}`)] : []),
  ])
  const wrap = (data: string) => view ? `uv:${view.id}:a:${data}` : data
  if(view?.sections){
    const summary=(view.section??'summary')==='summary'
    rows.push([button(tr(summary?k('Подробнее'):k('Свернуть')),`uv:${view.id}:s:${summary?'details':'summary'}`),button(tr('Закрыть отчёт'),`uv:${view.id}:x`)])
    if(summary)return new InlineKeyboard([...rows,[button(tr('« Статистика'),'hub:stats'),button(tr('🔄 Обновить'),`uv:${view.id}:r`)]])
    rows.push(['models','projects','users','limits'].map((name,i)=>button(tr([k('Модели'),k('Проекты и пользователи'),k('Пользователи'),k('Лимиты')][i]!),`uv:${view.id}:s:${name}`)))
    rows.push([button(tr('График'),`uv:${view.id}:c:tokens`),button(tr('Ответов модели'),`uv:${view.id}:c:requests`),button('API $',`uv:${view.id}:c:cost`)])
    rows.push([button(tr('Коммиты'),`uv:${view.id}:s:commits`)])
    rows.push([button('CSV',`uv:${view.id}:e:csv`),button('JSON',`uv:${view.id}:e:json`)])
    if(view.period!=='h5')rows.push((['rolling','current','previous'] as const).map((mode,i)=>button(tr([k('Последние дни'),k('Текущий период'),k('Предыдущий период')][i]!),`uv:${view.id}:m:${mode}`,view.mode===mode?'primary':undefined)))
  }
  // One row per limit, like the periods: off / with sound / silent, the chosen one marked.
  const seg = (on: boolean, text: string, data: string) => button(`${on ? '• ' : ''}${text}`, wrap(data), on ? 'primary' : undefined)
  const shownLimits = view ? view.limits.map(l => ({ ...l, resetsAt: l.resetsAt ? new Date(l.resetsAt) : null })) : l?.limits.items ?? []
  for (const [i, it] of shownLimits.entries()) {
    if (!it.resetsAt || it.stale || it.resetsAt.getTime()<=Date.now()) continue
    const req = parseRequest(d.store.get(`limit_notify:${it.label}`))
    const asked = req && windowKey(new Date(req.at)) === windowKey(it.resetsAt) && !req.off ? req : null
    rows.push([
      seg(!asked, tr('{v}: выкл', { v: tr(it.label) }), `lr:${i}:x`),
      seg(!!asked && !asked.silent, '🔔', `lr:${i}`),
      seg(!!asked?.silent, '🔕', `lr:${i}:s`),
    ])
  }
  const wOn = warmupOn(d)
  rows.push([seg(!wOn, tr('⚡ Окно: обычно'), 'us:w:off'), seg(wOn, tr('⚡ Сразу после сброса'), 'us:w:on')])
  rows.push([button(tr('« Статистика'), 'hub:stats'), button(tr('🔄 Обновить'), view ? `uv:${view.id}:r` : 'us:r')])
  return new InlineKeyboard(rows)
}

/** lr:<n>[:s] — remind about the reset of limit n (silently); us:p:<period> — the period of /usage sections; us:r — refresh. */
export async function handleResetCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const view = /^uv:([a-f0-9]{8}):(g|p|r|a|s|m|e|c|x)(?::(.+))?$/.exec(data)
  if (!view) return handleUsageAction(d, ctx, data)
  if (!ctx.from || String(ctx.from.id) !== owner()) { await ctx.answerCallbackQuery({ text: tr('Только для владельца подписки.') }).catch(() => {}); return true }
  return lockUsageView(d, view[1]!, async () => {
    const v = loadUsageView(d, view[1]!)
    if (!v || !ownsUsageView(v, ctx) || Date.now() - v.at > 7 * 86400_000) { await ctx.answerCallbackQuery({ text: tr('Отчёт устарел. Откройте /usage заново.') }).catch(() => {}); return true }
    if(v.dismissed){await ctx.answerCallbackQuery().catch(()=>{});return true}
    if (view[2] === 'a') return handleUsageAction(d, ctx, view[3]!, v)
    await ctx.answerCallbackQuery().catch(() => {})
    if(view[2]==='x'){
      v.dismissed=true;saveUsageView(d,v)
      await ctx.deleteMessage().catch(()=>ctx.editMessageText(tr('Отчёт закрыт'),{reply_markup:new InlineKeyboard([])}).catch(err=>d.log(`usage close: ${err}`)));return true
    }
    if(view[2]==='e'&&v.stats){
      const csv=view[3]==='csv',data=csv?csvStats(v.stats):JSON.stringify(exportStats(v.stats),null,2)
      await d.bot.api.sendDocument(v.chatId,new InputFile(Buffer.from(data),`usage-${v.id}.${csv?'csv':'json'}`),{message_thread_id:v.threadId,disable_notification:true});return true
    }
    if(view[2]==='c'&&v.stats){
      const metric=(['tokens','requests','cost'].includes(view[3]??'')?view[3]:'tokens') as 'tokens'|'requests'|'cost'
      const metricName=metric==='tokens'?tr('Токены'):metric==='requests'?tr('Ответов модели'):tr('В ценах API')
      const {rangeText}=await import('./analytics.ts')
      const svg=columnChartSvg({title:tr('График'),subtitle:`${metricName} · ${rangeText(v.stats.range)}`,columns:bucketStats(v.stats).map(b=>({label:b.label,value:b[metric]})),metric,labelEvery:2})
      const png=await svgToPng(svg)
      const caption=rangeText(v.stats.range)+(metric==='cost'?` · ${totalText(v.stats.total)} · ${tr('Оценка API, не списание подписки')}`:'')
      if(png)await d.bot.api.sendPhoto(v.chatId,new InputFile(png,`usage-${v.id}.png`),{caption,message_thread_id:v.threadId,disable_notification:true})
      else await d.bot.api.sendDocument(v.chatId,new InputFile(Buffer.from(svg),`usage-${v.id}.svg`),{message_thread_id:v.threadId,disable_notification:true});return true
    }
    if(view[2]==='s'&&v.sections){
      if(view[3]==='commits'&&v.stats){
        const {commitsSince}=await import('./git.ts')
        const lines=[tr('Коммиты')]
        for(const project of v.stats.projects){const commits=await commitsSince(project.key,new Date(v.stats.range.start),new Date(v.stats.range.end));if(commits?.length)lines.push(`<b>${escapeHtml(project.label)}</b>`,...commits.map(c=>escapeHtml(c)))}
        v.sections.commits=htmlPages(lines.join('\n'))
      }
      if(!v.sections[view[3]!])return true
      v.section=view[3];v.pages=v.sections[v.section!]!;v.page=0
    } else if (view[2] === 'g') {
      if (!/^\d{1,6}$/.test(view[3] ?? '')) return true
      v.page = Math.min(v.pages.length - 1, Math.max(0, Number(view[3])))
    } else {
      if(view[2]==='p'){if(!PERIODS.includes(view[3] as Period))return true;v.period=view[3] as Period;v.page=0;v.fixedRange=false}
      else if(view[2]==='m'){if(!['rolling','current','previous'].includes(view[3]??''))return true;v.mode=view[3] as RangeMode;v.page=0;v.fixedRange=false}
      else resetLimitsCache()
      v.at=Date.now();v.range=v.fixedRange&&v.range?v.range:analyticsRange(v.period,v.mode??'current',v.at,Intl.DateTimeFormat().resolvedOptions().timeZone)
      const content=await analyticsContent(d,v.range,planName(readOAuth()))
      if(v.category==='limits')content.sections.summary=content.sections.quota!
      if(v.section==='commits')v.section='details'
      v.stats=freezeAnalytics(content.stats);v.sections=content.sections;v.pages=v.sections[v.section??'summary']??v.sections.summary!;v.limits=content.limits
      v.page=Math.min(v.page,v.pages.length-1)
    }
    saveUsageView(d, v)
    const screen = renderUsageView(d, v)
    await ctx.editMessageText(screen.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: screen.kb }).catch(err => { if (!isMessageNotModified(err)) d.log(`usage pages: ${err}`) })
    return true
  })
}
async function handleUsageAction(d: Daemon, ctx: Context, data: string, view?: UsageView): Promise<boolean> {
  const p = /^us:(?:p:(h5|d|w|m)|r)$/.exec(data)
  const m = /^lr:(\d+)(?::(s|x))?$/.exec(data)
  const w = /^us:w:(on|off)$/.exec(data)
  const la = /^la:(r|x)(?::(\d+))?$/.exec(data)
  if (!m && !p && !w && !la) return false
  if (!ctx.from || String(ctx.from.id) !== owner()) {
    await ctx.answerCallbackQuery({ text: tr('Только для владельца подписки.') }).catch(() => {})
    return true
  }
  if (la) {
    if (la[1] === 'x') {
      await ctx.answerCallbackQuery().catch(() => {})
      await ctx.deleteMessage().catch(() => ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {}))
      return true
    }
    resetLimitsCache()
    const fresh = await fetchLimits()
    const l = typeof fresh === 'string' ? null : fresh.items[Number(la[2])]
    if (!l) { await ctx.answerCallbackQuery({ text: tr('Данные о лимитах устарели — откройте /usage заново.') }).catch(() => {}); return true }
    const level = settings.limitAlerts.filter(x => l.percent >= x).at(-1) ?? 0
    await ctx.answerCallbackQuery({ text: tr('🔄 Обновлено') }).catch(() => {})
    await ctx.editMessageText(alertText(l, level, Date.now()), { parse_mode: 'HTML', reply_markup: alertKb(Number(la[2])) })
      .catch(err => { if (!isMessageNotModified(err)) d.log(`limit refresh: ${err}`) })
    return true
  }
  if (w) {
    d.store.set('limit_warmup', w[1])
    const session = lastLimits()?.limits.items.find(l => l.label === LIMIT_LABELS.session)
    if (w[1] === 'on' && session?.resetsAt) scheduleWarmup(d, session.resetsAt)
    await ctx.answerCallbackQuery({ text: w[1] === 'on' ? tr('⚡ Окно будет запускаться сразу после сброса') : tr('Окно запускается как обычно') }).catch(() => {})
    await ctx.editMessageReplyMarkup({ reply_markup: usageKeyboard(d, view) }).catch(() => {})
    return true
  }
  if (p) {
    // us:r — the same view with fresh limits.
    if (p[1]) d.store.set('usage_period', p[1])
    else resetLimitsCache()
    await ctx.answerCallbackQuery({ text: tr('📊 Собираю…') }).catch(() => {})
    const screen = await usageScreen(d, viewScope(ctx))
    await ctx.editMessageText(screen.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: screen.kb })
      .catch(err => { if (!isMessageNotModified(err)) d.log(`usage period: ${err}`) })
    return true
  }
  if (!m) return true
  const stored = view?.limits[Number(m[1])]
  const it = view ? stored && { ...stored, resetsAt: stored.resetsAt ? new Date(stored.resetsAt) : null } : lastLimits()?.limits.items[Number(m[1])]
  if (!it?.resetsAt || it.resetsAt.getTime() <= Date.now()) {
    await ctx.answerCallbackQuery({ text: tr('Данные о лимитах устарели — откройте /usage заново.') }).catch(() => {})
    return true
  }
  const silent = m[2] === 's'
  const off = m[2] === 'x'
  requestResetNotice(d, it.label, it.resetsAt, silent, off)
  await ctx.answerCallbackQuery({ text: off ? tr('Без напоминания о сбросе') : `${silent ? tr('🔕 Тихо напомню') : tr('🔔 Напомню')} ${fmtReset(it.resetsAt, Date.now(), false)}` }).catch(() => {})
  await ctx.editMessageReplyMarkup({ reply_markup: usageKeyboard(d, view) }).catch(() => {})
  return true
}

export function startLimitWatch(d: Daemon): void {
  rescheduleRequested(d)
  // After a restart: the reset of the window seen last, if ⚡ is on.
  const session = lastLimits()?.limits.items.find(l => l.label === LIMIT_LABELS.session)
  if (warmupOn(d) && session?.resetsAt) scheduleWarmup(d, session.resetsAt)
  const min = settings.limitCheckMin
  if (min <= 0) return
  const tick = () => void checkLimits(d).catch(err => d.log(`limit check failed: ${err}`))
  setTimeout(tick, 15_000).unref?.()
  setInterval(tick, min * 60_000).unref?.()
}

/** An expired observation is unknown; never fabricate a new-window zero. */
export function freshCodexLimits(l: CodexLimits | null, now = Date.now()): Limit[] {
  return (l?.items ?? []).map(i => ({ ...i, observedAt:l?.at, ...(i.resetsAt && i.resetsAt.getTime() <= now ? { stale:true } : {}) }))
}

/**
 * The limits for the dashboard (HTML, a rich screen): a section per
 * subscription — its plan in the heading, the windows in a quote with the
 * percent in bold, a bar and when it resets. null before the first fetch.
 */
export function limitText(i:Limit,now=Date.now()):string {
  if(i.stale||i.resetsAt&&i.resetsAt.getTime()<=now)return `${escapeHtml(shortLabel(i.label))}: <b>${tr('Текущий лимит неизвестен')}</b> · ${tr('Последнее значение')}: ${Math.round(i.percent)}%`
  return `${escapeHtml(shortLabel(i.label))}: <b>${Math.round(i.percent)}%</b> ${bar(i.percent)} · ${tr('Осталось')}: ${Math.max(0,100-i.percent).toFixed(0)}%${i.resetsAt?`\n   ${escapeHtml(fmtReset(i.resetsAt,now))}`:''}`
}
export function freshness(at:number):string{return new Date(at).toLocaleString(locale(),{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'})}

export function limitsHtml(now = Date.now()): string | null {
  const l = lastLimits()
  const cx = collectCodex(now, 31).limits
  const codex = freshCodexLimits(cx, now)
  if (!l?.limits.items.length && !codex.length) return null
  const line = (i: Limit) => limitText(i,now)
  const out: string[] = []
  if (l?.limits.items.length) {
    const plan = planName(readOAuth())
    const extra = l.limits.breakdown ? [`<i>${escapeHtml(tr('За неделю: {v}', { v: l.limits.breakdown }))}</i>`] : []
    out.push(`${plan ? tr('🟠 <b>Claude</b> · {v}', { v: escapeHtml(plan) }) : '🟠 <b>Claude</b>'}\n<blockquote>${[...l.limits.items.map(line), ...extra].join('\n')}</blockquote>`)
  }
  if (codex.length) {
    const at = freshness(cx!.at)
    out.push(`${cx!.plan ? tr('⚫️ <b>Codex</b> · {v}', { v: escapeHtml(cx!.plan) }) : '⚫️ <b>Codex</b>'}\n<blockquote>${[...codex.map(line), `<i>${escapeHtml(tr('по последнему запросу, {at}', { at }))}</i>`].join('\n')}</blockquote>`)
  }
  return out.join('\n\n')
}

/** "📊 Claude: 5 часов 42% · Неделя 31%" — the brief dashboard; null before the first fetch. */
export function limitsLine(now = Date.now()): string | null {
  const claude = lastLimits()?.limits.items ?? []
  const codex = freshCodexLimits(collectCodex(now, 31).limits, now)
  const part = (name: string, items: Limit[]) => `${name}: ` + items.map(i => `${shortLabel(i.label)} ${i.stale||i.resetsAt&&i.resetsAt.getTime()<=now?tr('неизвестно'):`${Math.round(i.percent)}%`}`).join(' · ')
  const parts = [...(claude.length ? [part('Claude', claude)] : []), ...(codex.length ? [part('Codex', codex)] : [])]
  return parts.length ? '📊 ' + parts.join(' │ ') : null
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
/**
 * What one turn of a session cost: its transcript entries since the turn
 * began. «🔢 18 тыс. ток. · кэш 96% · $0.05»; null when nothing was counted.
 */
/** A session's requests of the last day, from its engine's own logs (Codex: its exact usage counters). */
function sessionEntries(s: Session, now: number): Entry[] {
  return s.engine === 'codex' ? collectCodex(now, 1).entries : collectEntries(now, 1)
}

export function turnCostLine(s: Session, since: number, now = Date.now(), rich = false): string | null {
  const sum: Sum = { tokens: 0, cost: 0, unpriced: 0 }
  let read = 0
  for (const e of sessionEntries(s, now)) {
    if (e.ts < since || (e.cwd !== s.cwd && e.cwd !== s.projectKey)) continue
    add(sum, e)
    read += e.read
  }
  if (!sum.tokens) return null
  const cache = Math.round((read / sum.tokens) * 100)
  const vars = { v: fmtTok(sum.tokens), cache, cost: sum.cost.toFixed(2), took: fmtDuration(now - since) }
  // Unknown model prices remain explicit rather than a fabricated zero.
  if (sum.unpriced > 0 && sum.cost === 0) return rich ? tr('🔢 **Ход** · {took}\n{v} ток. · кэш {cache}%', vars) : tr('🔢 Ход: {v} ток. · кэш {cache}%', vars)
  // Rich (Markdown) for sendRichMessage, plain text if that fails.
  return rich ? tr('🔢 **Ход** · {took}\n{v} ток. · кэш {cache}% · **${cost}**', vars) : tr('🔢 Ход: {v} ток. · кэш {cache}% · ${cost}', vars)
}

/**
 * FR-11: the turn's cost to append under its answer (rich HTML): a grey
 * footer line with the gist and a collapsed table with everything — time,
 * requests, models, tokens by kind, API price. Null when nothing was counted.
 */
export function turnCostBlock(s: Session, since: number, now = Date.now()): string | null {
  const sum: Sum = { tokens: 0, cost: 0, unpriced: 0 }
  const k = { input: 0, output: 0, read: 0, write5m: 0, write1h: 0 }
  const models = new Map<string, number>()
  let requests = 0
  for (const e of sessionEntries(s, now)) {
    if (e.ts < since || (e.cwd !== s.cwd && e.cwd !== s.projectKey)) continue
    add(sum, e)
    for (const f of ['input', 'output', 'read', 'write5m', 'write1h'] as const) k[f] += e[f]
    const m = modelKey(e)
    models.set(m, (models.get(m) ?? 0) + 1)
    requests++
  }
  if (!sum.tokens) return null
  const cache = Math.round((k.read / sum.tokens) * 100)
  const took = fmtDuration(now - since)
  const row = (name: string, v: string) => `<tr><td>${escapeHtml(name)}</td><td align="right">${v}</td></tr>`
  const rows = [
    row(tr('Время'), took),
    row(tr('Запросов к модели'), String(requests)),
    row(tr('Агент'), escapeHtml(engineOf(s.engine).name)),
    row(tr('Модель'), escapeHtml([...models.entries()].map(([m, n]) => models.size > 1 ? `${m} ×${n}` : m).join(', '))),
    row(tr('Ввод'), fmtTok(k.input)),
    row(tr('Вывод'), fmtTok(k.output)),
    row(tr('Чтение кэша'), `${fmtTok(k.read)} (${cache}%)`),
    row(tr('Запись в кэш'), fmtTok(k.write5m + k.write1h)),
    row(tr('Всего'), tr('{v} ток.', { v: fmtTok(sum.tokens) })),
    row(tr('В ценах API'), (sum.unpriced===requests?'—':`<b>≈$${sum.cost.toFixed(2)}</b>`) + (sum.unpriced ? tr(' (+{unpriced} без цены)', { unpriced: sum.unpriced }) : '')),
  ]
  const gist = sum.unpriced===requests
    ? tr('🔢 {took} · {v} ток. · кэш {cache}%', { took, v: fmtTok(sum.tokens), cache })
    : tr('🔢 {took} · {v} ток. · кэш {cache}% · ${cost}', { took, v: fmtTok(sum.tokens), cache, cost: sum.cost.toFixed(2) })
  return `<details><summary>${escapeHtml(tr('🔢 Расход хода'))}</summary><table bordered striped compact>${rows.join('')}</table></details><footer>${escapeHtml(gist)}</footer>`
}

export function sessionCostLine(s: Session, now = Date.now()): string | null {
  const since = startOfDay(now)
  const sum: Sum = { tokens: 0, cost: 0, unpriced: 0 }
  for (const e of sessionEntries(s, now)) if (e.ts >= since && (e.cwd === s.cwd || e.cwd === s.projectKey)) add(sum, e)
  if (!sum.tokens) return null
  return sum.unpriced&&sum.cost===0?tr('💸 сегодня {v} ток. (Codex)',{v:fmtTok(sum.tokens)}):tr('💸 сегодня ${v} · {v2} ток.',{v:sum.cost.toFixed(2),v2:fmtTok(sum.tokens)})
}

