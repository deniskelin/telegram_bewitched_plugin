/**
 * FR-19: orphaned agent processes. A Claude Code or Codex started by the
 * bridge (our launch flags) that has no connected session for a long time —
 * a second copy left by a double launch, a session whose channel broke, a
 * window nobody looks at — keeps memory and may hold a conversation lock.
 * The daemon never kills them on its own: the owner gets one notice per set
 * of such processes, with «🧹 Завершить» (SIGTERM) or «Оставить».
 */

import { InlineKeyboard, type Context } from 'grammy'
import { readdirSync, readFileSync } from 'fs'
import { owner } from '../access.ts'
import { escapeHtml } from '../format.ts'
import { t as tr } from '../i18n/index.ts'
import { agentOf, cmdlineOf, cwdOf } from '../proc.ts'
import type { Daemon } from './daemon.ts'
import { sendNotice } from './journal.ts'
import { button } from './stream.ts'

export type Orphan = { pid: number; agent: 'claude' | 'codex'; ageSec: number; rssMb: number; cwd: string | null }

/** Older than this without a session: not a launch that is still starting. */
const MIN_AGE_SEC = 15 * 60

/** Our launch: Claude with the bewitched channel, Codex with the bewitched profile. */
export function isBridgeLaunch(argv: string[]): boolean {
  const s = argv.join(' ')
  return /plugin:telegram-bewitched@/.test(s) || /(?:^|\s)-p\s+bewitched(?:-\w+)?(?:\s|$)/.test(s)
}

function procAgeSec(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0])
    const hz = 100
    return Math.max(0, Math.round(uptime - start / hz))
  } catch {
    return null
  }
}

function rssMb(pid: number): number {
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
    return m ? Math.round(Number(m[1]) / 1024) : 0
  } catch {
    return 0
  }
}

export type OrphanReads = { pids: () => number[]; argv: (pid: number) => string[]; agent: (pid: number) => 'claude' | 'codex' | null; age: (pid: number) => number | null; rss: (pid: number) => number; cwd: (pid: number) => string | null }

const procReads: OrphanReads = {
  pids: () => {
    try {
      return readdirSync('/proc').filter(f => /^\d+$/.test(f)).map(Number)
    } catch {
      return []
    }
  },
  argv: cmdlineOf,
  agent: agentOf,
  age: procAgeSec,
  rss: rssMb,
  cwd: cwdOf,
}

/** Bridge-launched agents with no connected session, older than MIN_AGE_SEC. */
export function findOrphans(d: Daemon, reads: OrphanReads = procReads): Orphan[] {
  const connected = new Set([...d.sessions.values()].map(s => s.claudePid).filter((p): p is number => p != null))
  const out: Orphan[] = []
  for (const pid of reads.pids()) {
    if (pid === process.pid || connected.has(pid)) continue
    const agent = reads.agent(pid)
    if (!agent || !isBridgeLaunch(reads.argv(pid))) continue
    const age = reads.age(pid)
    if (age == null || age < MIN_AGE_SEC) continue
    const cwd = reads.cwd(pid)
    // A launch the daemon is still waiting for (a question on its screen) is not an orphan.
    if (cwd && d.launching.has(cwd)) continue
    out.push({ pid, agent, ageSec: age, rssMb: reads.rss(pid), cwd })
  }
  return out.sort((a, b) => a.pid - b.pid)
}

function fmtAge(sec: number): string {
  const h = Math.floor(sec / 3600)
  return h >= 24 ? tr('{n} д', { n: Math.floor(h / 24) }) : h ? tr('{n} ч', { n: h }) : tr('{n} мин', { n: Math.round(sec / 60) })
}

export function orphansText(list: Orphan[]): string {
  const lines = [tr('🧹 <b>Процессы без сессии</b>: {n}', { n: list.length }), tr('Запущены мостом, но не подключены к нему дольше 15 минут: память занята, а разговор может быть заблокирован.'), '']
  for (const o of list) lines.push(`• <code>${o.pid}</code> ${o.agent === 'codex' ? 'Codex' : 'Claude Code'} · ${fmtAge(o.ageSec)} · ${o.rssMb} MB${o.cwd ? ` · <code>${escapeHtml(o.cwd)}</code>` : ''}`)
  return lines.join('\n')
}

/** Notice the owner once per new set of orphans. */
export async function checkOrphans(d: Daemon, reads: OrphanReads = procReads): Promise<Orphan[]> {
  const list = findOrphans(d, reads)
  const sig = list.map(o => o.pid).join(',')
  const prev = d.store.get('orphans_sig') ?? ''
  if (!list.length) {
    if (prev) d.store.set('orphans_sig', null)
    return list
  }
  if (sig === prev) return list
  // Only a set with a pid not seen before is news: one that shrank is not.
  const seen = new Set(prev.split(',').filter(Boolean))
  d.store.set('orphans_sig', sig)
  if (list.every(o => seen.has(String(o.pid)))) return list
  if (!owner()) return list
  await sendNotice(d, 'sessions', () => orphansText(list), () => ({
    reply_markup: new InlineKeyboard([[button(tr('🧹 Завершить'), `orph:kill:${sig}`, 'danger'), button(tr('Оставить'), 'orph:keep')]]),
  }))
  return list
}

export function startOrphanWatch(d: Daemon): void {
  setInterval(() => void checkOrphans(d).catch(err => d.log(`orphan check failed: ${err}`)), 30 * 60_000).unref?.()
  setTimeout(() => void checkOrphans(d).catch(err => d.log(`orphan check failed: ${err}`)), 5 * 60_000).unref?.()
}

/** orph:kill:<pids>, orph:keep — only the owner; only pids that are still orphans are signalled. */
export async function handleOrphanCallback(d: Daemon, ctx: Context, data: string, reads: OrphanReads = procReads, kill: (pid: number) => void = pid => process.kill(pid, 'SIGTERM')): Promise<boolean> {
  const m = /^orph:(kill|keep)(?::([\d,]+))?$/.exec(data)
  if (!m) return false
  if (!ctx.from || String(ctx.from.id) !== owner()) {
    await ctx.answerCallbackQuery({ text: tr('Только владелец.') }).catch(() => {})
    return true
  }
  if (m[1] === 'keep') {
    await ctx.answerCallbackQuery({ text: tr('Оставил') }).catch(() => {})
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
    return true
  }
  const still = new Set(findOrphans(d, reads).map(o => o.pid))
  const asked = (m[2] ?? '').split(',').filter(Boolean).map(Number)
  const done: number[] = []
  for (const pid of asked) {
    if (!still.has(pid)) continue
    try {
      kill(pid)
      done.push(pid)
    } catch (err) {
      d.log(`orphan ${pid}: kill failed: ${err}`)
    }
  }
  d.log(`orphans: SIGTERM to ${done.join(', ') || 'none'}`)
  // A repeat tap (or the processes already gone): say so and drop the buttons.
  if (!done.length) {
    await ctx.answerCallbackQuery({ text: tr('Уже неактуально.') }).catch(() => {})
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
    return true
  }
  await ctx.answerCallbackQuery({ text: tr('🧹 Завершено: {n}', { n: done.length }) }).catch(() => {})
  // The notice went out as a rich message (its first line is a screen title), which has no `text`
  // to append to: rebuild it from the pids. Without reply_markup the buttons go away.
  const lines = [tr('🧹 <b>Процессы без сессии</b>: {n}', { n: asked.length }), '', ...asked.map(pid => `• <code>${pid}</code>${done.includes(pid) ? ' — SIGTERM' : ''}`), '', tr('🧹 Завершено: {n}', { n: done.length })]
  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML' }).catch(async err => {
    d.log(`orphans: notice edit failed: ${err}`)
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
  })
  return true
}

