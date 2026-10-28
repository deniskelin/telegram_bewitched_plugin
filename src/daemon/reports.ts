/**
 * Period reports to the owner: the day (by hour), the week (by day) and the
 * month (by week), sent when the period ends, each switched on or off in
 * /reports. A chart of spend plus text: totals against the previous period,
 * models, sessions, commits, the peak and the current limits.
 */

import { InlineKeyboard, InputFile, type Bot, type Context } from 'grammy'
import { isOwner, owner } from '../access.ts'
import { escapeHtml } from '../format.ts'
import { columnChartSvg, svgToPng, type Column } from './chart.ts'
import type { Daemon } from './daemon.ts'
import { commitsSince } from './git.ts'
import { button } from './stream.ts'
import { add, collectEntries, fmtSum, fmtTok, limitsLine, ownerOf, type Entry, type Sum } from './usage.ts'

export type Kind = 'day' | 'week' | 'month'
const KINDS: Kind[] = ['day', 'week', 'month']
const KIND_NAME: Record<Kind, string> = { day: 'за сутки', week: 'за неделю', month: 'за месяц' }
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

// --------------------------------------------------------------------------
// Periods (local time)
// --------------------------------------------------------------------------

export type Period = { kind: Kind; start: Date; end: Date }

function midnight(t: Date): Date {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d
}

/** The last complete period of this kind before `now`. */
export function lastPeriod(kind: Kind, now = new Date()): Period {
  const today = midnight(now)
  if (kind === 'day') {
    const start = new Date(today)
    start.setDate(start.getDate() - 1)
    return { kind, start, end: today }
  }
  if (kind === 'week') {
    const end = new Date(today)
    end.setDate(end.getDate() - ((end.getDay() + 6) % 7)) // this Monday
    const start = new Date(end)
    start.setDate(start.getDate() - 7)
    return { kind, start, end }
  }
  const end = new Date(today.getFullYear(), today.getMonth(), 1)
  return { kind, start: new Date(end.getFullYear(), end.getMonth() - 1, 1), end }
}

/** The period of the same kind just before p. */
function previous(p: Period): Period {
  return lastPeriod(p.kind, p.start)
}

/** Chart buckets: hours of the day, days of the week, 7-day chunks of the month. */
export function buckets(p: Period): { label: string; start: number; end: number }[] {
  const out: { label: string; start: number; end: number }[] = []
  if (p.kind === 'day') {
    for (let h = 0; h < 24; h++) {
      const s = new Date(p.start); s.setHours(h)
      const e = new Date(p.start); e.setHours(h + 1)
      out.push({ label: String(h), start: s.getTime(), end: e.getTime() })
    }
  } else if (p.kind === 'week') {
    for (let i = 0; i < 7; i++) {
      const s = new Date(p.start); s.setDate(s.getDate() + i)
      const e = new Date(p.start); e.setDate(e.getDate() + i + 1)
      out.push({ label: `${WEEKDAYS[i]} ${s.getDate()}`, start: s.getTime(), end: e.getTime() })
    }
  } else {
    for (let day = 1; ; day += 7) {
      const s = new Date(p.start.getFullYear(), p.start.getMonth(), day)
      if (s >= p.end) break
      const e = new Date(Math.min(new Date(p.start.getFullYear(), p.start.getMonth(), day + 7).getTime(), p.end.getTime()))
      const last = new Date(e.getTime() - 1).getDate()
      out.push({ label: `${day}–${last}`, start: s.getTime(), end: e.getTime() })
    }
  }
  return out
}

function periodTitle(p: Period): string {
  const dm = (t: Date) => t.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  if (p.kind === 'day') return `${dm(p.start)}, ${p.start.toLocaleDateString('ru-RU', { weekday: 'long' })}`
  if (p.kind === 'week') return `${dm(p.start)} — ${dm(new Date(p.end.getTime() - 1))}`
  const m = p.start.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '')
  return m[0].toUpperCase() + m.slice(1)
}

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------

function share(part: number, whole: number): string {
  const pct = (part / (whole || 1)) * 100
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`
}

const empty = (): Sum => ({ tokens: 0, cost: 0, unpriced: 0 })

function sumOf(entries: Entry[]): Sum {
  const s = empty()
  for (const e of entries) add(s, e)
  return s
}

function groupBy(entries: Entry[], key: (e: Entry) => string): [string, Sum][] {
  const m = new Map<string, Sum>()
  for (const e of entries) {
    const k = key(e)
    const s = m.get(k) ?? empty()
    add(s, e)
    m.set(k, s)
  }
  return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost)
}

function change(cur: number, prev: number, word: string): string {
  if (prev <= 0) return ''
  const pct = Math.round(((cur - prev) / prev) * 100)
  return pct === 0 ? ` · как ${word}` : ` · ${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% к ${word}`
}

const PREV_WORD: Record<Kind, string> = { day: 'прошлому дню', week: 'прошлой неделе', month: 'прошлому месяцу' }

export type Report = { caption: string; text: string; png: Buffer | null; svg: string }

export async function buildReport(d: Daemon, p: Period): Promise<Report> {
  const prev = previous(p)
  const all = collectEntries(p.end.getTime(), Math.ceil((p.end.getTime() - prev.start.getTime()) / 86_400_000) + 1)
  const inP = all.filter(e => e.ts >= p.start.getTime() && e.ts < p.end.getTime())
  const inPrev = all.filter(e => e.ts >= prev.start.getTime() && e.ts < prev.end.getTime())
  const total = sumOf(inP)
  const before = sumOf(inPrev)

  const cols: Column[] = buckets(p).map(b => ({ label: b.label, value: sumOf(inP.filter(e => e.ts >= b.start && e.ts < b.end)).cost }))
  const title = `Расход ${KIND_NAME[p.kind]} · ${periodTitle(p)}`
  const subtitle = `$${total.cost.toFixed(2)} в ценах API · ${fmtTok(total.tokens)} токенов · по ${p.kind === 'day' ? 'часам' : p.kind === 'week' ? 'дням' : 'неделям'}`
  const svg = columnChartSvg({ title, subtitle, columns: cols, labelEvery: p.kind === 'day' ? 3 : 1 })
  const png = await svgToPng(svg)

  const lines: string[] = [`📊 <b>Статистика ${KIND_NAME[p.kind]}</b> · ${escapeHtml(periodTitle(p))}`]
  lines.push(`💸 ${fmtSum(total)}${change(total.cost, before.cost, PREV_WORD[p.kind])}`)
  if (inP.length) {
    lines.push(`🔁 Ответов модели: ${inP.length}${change(inP.length, inPrev.length, PREV_WORD[p.kind])}`)
    const active = cols.filter(c => c.value > 0).length
    const peak = cols.reduce((a, b) => (b.value > a.value ? b : a), cols[0])
    const unit = p.kind === 'day' ? ['Активных часов', 'Пик', (l: string) => `${l}:00–${Number(l) + 1}:00`] as const
      : p.kind === 'week' ? ['Активных дней', 'Пик', (l: string) => l] as const
      : ['Активных недель', 'Пик', (l: string) => `${l} числа`] as const
    lines.push(`⏱ ${unit[0]}: ${active} из ${cols.length} · ${unit[1]}: ${escapeHtml(unit[2](peak.label))} ($${peak.value.toFixed(2)})`)

    const models = groupBy(inP, e => e.model.replace(/^claude-/, ''))
    lines.push('', '🧠 <b>Модели</b>', ...models.map(([k, s]) => `• ${escapeHtml(k)}: $${s.cost.toFixed(2)} · ${fmtTok(s.tokens)} · ${share(s.cost, total.cost)}`))
    const sessions = groupBy(inP, e => e.cwd)
    lines.push('', '🗂 <b>Сессии</b>')
    for (const [cwd, s] of sessions.slice(0, 8)) {
      const commits = cwd ? await commitsSince(cwd, p.start, p.end) : null
      lines.push(`• ${escapeHtml(ownerOf(d, cwd))}: $${s.cost.toFixed(2)}${commits?.length ? ` · коммитов ${commits.length}` : ''}`)
    }
    if (sessions.length > 8) lines.push(`… ещё ${sessions.length - 8}`)
    // Cache reads dominate long sessions: worth knowing what the money went to.
    const read = inP.reduce((n, e) => n + e.read, 0)
    lines.push('', `📦 Из кэша прочитано ${Math.round((read / (total.tokens || 1)) * 100)}% токенов`)
  } else {
    lines.push('Сессии в этот период не работали.')
  }
  const limits = limitsLine()
  if (limits) lines.push(limits)
  lines.push('', '<i>Стоимость — если бы те же токены шли через API. /reports — настройки отчётов.</i>')
  return { caption: `📊 ${escapeHtml(title)}`, text: lines.join('\n'), png, svg }
}

async function sendReport(d: Daemon, chatId: string, r: Report): Promise<void> {
  if (r.png) await d.bot.api.sendPhoto(chatId, new InputFile(r.png, 'report.png'), { caption: r.caption, parse_mode: 'HTML' })
  else await d.bot.api.sendDocument(chatId, new InputFile(Buffer.from(r.svg), 'report.svg'), { caption: r.caption, parse_mode: 'HTML' })
  await d.bot.api.sendMessage(chatId, r.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
}

// --------------------------------------------------------------------------
// Settings and schedule
// --------------------------------------------------------------------------

export function reportSettings(d: Daemon): Record<Kind, boolean> {
  try {
    return { day: false, week: false, month: false, ...JSON.parse(d.store.get('reports') ?? '{}') }
  } catch {
    return { day: false, week: false, month: false }
  }
}

const sentKey = (p: Period) => `report_sent:${p.kind}:${p.end.toISOString()}`

/** Switching a report on doesn't send the period that already ended: the next one is the first. */
export function setReport(d: Daemon, kind: Kind, on: boolean): void {
  d.store.set('reports', JSON.stringify({ ...reportSettings(d), [kind]: on }))
  if (on) d.store.set(sentKey(lastPeriod(kind)), '1')
}

/** Send the reports whose period has ended and that are switched on. */
export async function sendDueReports(d: Daemon, now = new Date()): Promise<void> {
  const to = owner()
  if (!to) return
  const on = reportSettings(d)
  for (const kind of KINDS) {
    if (!on[kind]) continue
    const p = lastPeriod(kind, now)
    if (d.store.get(sentKey(p))) continue
    d.store.set(sentKey(p), '1')
    await sendReport(d, to, await buildReport(d, p)).catch(err => d.log(`report ${kind} failed: ${err}`))
  }
}

export function startReports(d: Daemon): void {
  setInterval(() => void sendDueReports(d).catch(err => d.log(`reports failed: ${err}`)), 60_000).unref?.()
}

// --------------------------------------------------------------------------
// /reports
// --------------------------------------------------------------------------

const WHEN: Record<Kind, string> = { day: 'в 00:00 за прошедшие сутки', week: 'в понедельник за прошлую неделю', month: '1-го числа за прошлый месяц' }

function settingsScreen(d: Daemon): { text: string; kb: InlineKeyboard } {
  const on = reportSettings(d)
  const lines = ['📊 <b>Отчёты о потреблении</b>', 'График расхода и статистика приходят сюда, когда период закончился.', '']
  for (const k of KINDS) lines.push(`${on[k] ? '✅' : '⬜️'} ${KIND_NAME[k][0].toUpperCase() + KIND_NAME[k].slice(1)} — ${WHEN[k]}`)
  const kb = new InlineKeyboard([
    KINDS.map(k => button(`${on[k] ? '✅' : '⬜️'} ${k === 'day' ? 'День' : k === 'week' ? 'Неделя' : 'Месяц'}`, `rp:t:${k}`, on[k] ? 'success' : undefined)),
    KINDS.map(k => button(`📨 ${k === 'day' ? 'Вчера' : k === 'week' ? 'Прошл. неделя' : 'Прошл. месяц'}`, `rp:now:${k}`)),
  ])
  return { text: lines.join('\n'), kb }
}

export function registerReportCommands(d: Daemon, bot: Bot): void {
  bot.command('reports', async ctx => {
    if (ctx.chat?.type !== 'private' || !isOwner(ctx.from!.id)) return
    const { text, kb } = settingsScreen(d)
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb })
  })
}

export async function handleReportCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^rp:(t|now):(day|week|month)$/.exec(data)
  if (!m) return false
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: 'Нет доступа.' }).catch(() => {})
    return true
  }
  const kind = m[2] as Kind
  if (m[1] === 't') {
    const on = !reportSettings(d)[kind]
    setReport(d, kind, on)
    await ctx.answerCallbackQuery({ text: `${on ? '✅ Включён' : '⬜️ Выключен'} отчёт ${KIND_NAME[kind]}` }).catch(() => {})
    const { text, kb } = settingsScreen(d)
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
    return true
  }
  await ctx.answerCallbackQuery({ text: '📨 Собираю отчёт…' }).catch(() => {})
  await sendReport(d, String(ctx.chat!.id), await buildReport(d, lastPeriod(kind)))
  return true
}
