/**
 * Codex in /usage (FR-16): what Codex sessions spent and how much of its
 * ChatGPT-plan windows is used, read from its own session logs
 * ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl) — no request is made.
 *
 * Every model request ends with a token_count event: the running totals of
 * the thread and the plan's rate limits as of that request. Usage is the
 * growth of the totals (an event can repeat them); the limits are those of
 * the newest event across all logs, so they are as fresh as the last Codex
 * request.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { k } from '../i18n/index.ts'
import type { Entry, Limit } from './usage.ts'

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex')

type Totals = { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
type Window = { used_percent?: number; window_minutes?: number; resets_at?: number } | null
export type CodexLimits = { at: number; plan: string | null; items: Limit[] }

/** «Codex: 5 часов», «Codex: неделя» — by the window's length, like Claude's. */
function windowLabel(minutes: number | undefined): string {
  if (minutes === 300) return k('Codex: 5 часов')
  if (minutes === 10080) return k('Codex: неделя')
  return minutes ? `Codex: ${Math.round(minutes / 60)} h` : 'Codex'
}

/** One rollout: an entry per model request (the growth of the totals), and the newest rate limits. */
export function parseRollout(text: string, file: string, since: number): { entries: Entry[]; limits: CodexLimits | null } {
  const entries: Entry[] = []
  let cwd = ''
  let model = 'codex'
  let prev = { input: 0, cached: 0, output: 0 }
  let limits: CodexLimits | null = null
  for (const [n, line] of text.split('\n').entries()) {
    if (!line) continue
    let m: { timestamp?: string; type?: string; payload?: Record<string, unknown> }
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    const p = m.payload ?? {}
    if (m.type === 'session_meta' && typeof p.cwd === 'string') cwd = p.cwd
    else if (m.type === 'turn_context' && typeof p.model === 'string') model = p.model
    else if (m.type === 'event_msg' && p.type === 'token_count') {
      const ts = Date.parse(m.timestamp ?? '')
      const total = (p.info as { total_token_usage?: Totals } | null)?.total_token_usage
      if (total) {
        const now = { input: total.input_tokens ?? 0, cached: total.cached_input_tokens ?? 0, output: total.output_tokens ?? 0 }
        const grew = now.input + now.output > prev.input + prev.output
        if (grew && ts >= since) {
          const cached = Math.max(0, now.cached - prev.cached)
          entries.push({
            id: `codex:${file}:${n}`, ts, model, cwd,
            input: Math.max(0, now.input - prev.input - cached),
            output: Math.max(0, now.output - prev.output),
            write5m: 0, write1h: 0, read: cached,
          })
        }
        if (grew) prev = now
      }
      const rl = p.rate_limits as { primary?: Window; secondary?: Window; plan_type?: string } | undefined
      if (rl && ts >= (limits?.at ?? 0)) {
        const items = [rl.primary, rl.secondary].filter((w): w is NonNullable<Window> => !!w && typeof w.used_percent === 'number')
          .map(w => ({ label: windowLabel(w.window_minutes), percent: w.used_percent!, resetsAt: w.resets_at ? new Date(w.resets_at * 1000) : null }))
        limits = { at: ts, plan: typeof rl.plan_type === 'string' ? rl.plan_type : null, items }
      }
    }
  }
  return { entries, limits }
}

function* rollouts(dir: string, depth = 0): Generator<string> {
  let items: string[]
  try {
    items = readdirSync(dir)
  } catch {
    return
  }
  for (const name of items) {
    const p = join(dir, name)
    if (name.endsWith('.jsonl')) yield p
    else if (depth < 3 && /^\d+$/.test(name)) yield* rollouts(p, depth + 1)
  }
}

const cache = new Map<string, { mtime: number; size: number; entries: Entry[]; limits: CodexLimits | null }>()
const CACHE_DAYS = 64

/** Codex requests of the last `days` days and its newest rate limits; unchanged logs come from the cache. */
export function collectCodex(now = Date.now(), days = 7, home = CODEX_HOME): { entries: Entry[]; limits: CodexLimits | null } {
  const since = now - days * 86_400_000
  const entries: Entry[] = []
  let limits: CodexLimits | null = null
  const alive = new Set<string>()
  for (const file of rollouts(join(home, 'sessions'))) {
    let st
    try {
      st = statSync(file)
    } catch {
      continue
    }
    if (st.mtimeMs < now - CACHE_DAYS * 86_400_000) continue
    alive.add(file)
    let c = cache.get(file)
    if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) {
      try {
        c = { mtime: st.mtimeMs, size: st.size, ...parseRollout(readFileSync(file, 'utf8'), file, now - CACHE_DAYS * 86_400_000) }
      } catch {
        continue
      }
      cache.set(file, c)
    }
    for (const e of c.entries) if (e.ts >= since) entries.push(e)
    if (c.limits && c.limits.at > (limits?.at ?? 0)) limits = c.limits
  }
  for (const f of cache.keys()) if (!alive.has(f)) cache.delete(f)
  return { entries, limits }
}
