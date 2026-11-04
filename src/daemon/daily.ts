/**
 * «🌙 Итоги дня» — one rich message at 00:00 for the day that ended: the
 * spending chart inside the message, then a section per subscription
 * (Claude in API prices, Codex in tokens), sessions with their commits, and
 * the limits. It replaces the 21:00 digest and the day report (a photo plus
 * a separate text). /digest and «🌙 Итоги дня» in the menu send the same for
 * today so far. Without rich messages (older Bot API) the day report goes as
 * before: the chart as a photo, the text after it.
 */

import { settings } from '../config.ts'
import { collectCodex } from './codexusage.ts'
import { columnChartSvg, svgToPng, type Column } from './chart.ts'
import type { Daemon } from './daemon.ts'
import { commitsSince } from './git.ts'
import { add, collectEntries, fmtTok, limitsLine, modelKey, ownerOf, type Entry, type Sum } from './usage.ts'
import { buckets, midnight, type Period } from './reports.ts'
import { locale, t } from '../i18n/index.ts'
import { hardBreaks } from '../rich.ts'

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
  return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens)
}

/** Text from folders, models and commit subjects inside rich Markdown. */
export function md(s: string): string {
  return s.replace(/([\\`*_[\]|<>#~])/g, '\\$1')
}

function pct(part: number, whole: number): string {
  const p = (part / (whole || 1)) * 100
  return p > 0 && p < 1 ? '\\<1%' : `${Math.round(p)}%`
}

function change(cur: number, prev: number): string {
  if (prev <= 0) return ''
  const p = Math.round(((cur - prev) / prev) * 100)
  return p === 0 ? t(' · как вчера') : t(' · {v} {v2}% к прошлому дню', { v: p > 0 ? '▲' : '▼', v2: Math.abs(p) })
}

/** Today from midnight to now: what /digest shows. */
export function todaySoFar(now = new Date()): Period {
  return { kind: 'day', start: midnight(now), end: now }
}

export type Daily = { markdown: string; png: Buffer | null }

export async function buildDaily(d: Daemon, p: Period): Promise<Daily> {
  const full = p.end.getTime() - p.start.getTime() >= 86_400_000 - 3600_000
  const prevStart = p.start.getTime() - 86_400_000
  const inP = (e: Entry) => e.ts >= p.start.getTime() && e.ts < p.end.getTime()
  const claudeAll = collectEntries(p.end.getTime(), 3)
  const claude = claudeAll.filter(inP)
  const claudePrev = claudeAll.filter(e => e.ts >= prevStart && e.ts < p.start.getTime())
  const codex = collectCodex(p.end.getTime(), 3).entries.filter(inP)
  const total = sumOf(claude)
  const cxTotal = sumOf(codex)

  const date = p.start.toLocaleDateString(locale(), { day: 'numeric', month: 'long' })
  const weekday = p.start.toLocaleDateString(locale(), { weekday: 'long' })
  const out: string[] = [full ? t('# 🌙 Итоги дня · {date}, {weekday}', { date, weekday }) : t('# 🌙 Сегодня · {date}, до {time}', { date, time: p.end.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) }), '---']

  // The chart: Claude's API-price spending by hour.
  const cols: Column[] = buckets({ ...p, end: new Date(p.start.getTime() + 86_400_000) }).map(b => ({ label: b.label, value: sumOf(claude.filter(e => e.ts >= b.start && e.ts < b.end)).cost }))
  let png: Buffer | null = null
  if (claude.length) {
    const svg = columnChartSvg({ title: t('Расход Claude по часам · {date}', { date }), subtitle: t('${v} в ценах API · {v2} токенов', { v: total.cost.toFixed(2), v2: fmtTok(total.tokens) }), columns: cols, labelEvery: 3 })
    png = await svgToPng(svg)
    if (png) out.push('![](tg://photo?id=chart)')
  }

  if (!claude.length && !codex.length) out.push(t('Сессии в этот день не работали.'))

  // --- Claude ---
  if (claude.length) {
    const active = cols.filter(c => c.value > 0).length
    const peak = cols.reduce((a, b) => (b.value > a.value ? b : a), cols[0])
    const read = claude.reduce((n, e) => n + e.read, 0)
    out.push(t('## 🟠 Claude'))
    out.push([
      t('**${v}** в ценах API · {v2} ток.{v3}', { v: total.cost.toFixed(2), v2: fmtTok(total.tokens), v3: full ? change(total.cost, sumOf(claudePrev).cost) : '' }),
      t('🔁 Ответов модели: {n} · ⏱ активных часов: {active} из 24', { n: claude.length, active }),
      t('📈 Пик: {from}:00–{to}:00 (${v}) · 📦 из кэша {cache}% токенов', { from: peak.label, to: Number(peak.label) + 1, v: peak.value.toFixed(2), cache: Math.round((read / (total.tokens || 1)) * 100) }),
    ].join('\n'))
    const models = groupBy(claude, modelKey)
    out.push([`| ${t('Модель')} | $ | ${t('Токены')} | ${t('Доля')} |`, '|---|---:|---:|---:|',
      ...models.map(([m, s]) => `| ${md(m)} | ${s.cost.toFixed(2)} | ${fmtTok(s.tokens)} | ${pct(s.cost, total.cost)} |`)].join('\n'))
  }

  // --- Codex ---
  if (codex.length) {
    out.push(t('## ⚫️ Codex'))
    out.push(t('**{v} ток.** · ответов модели: {n} · цены API для Codex нет', { v: fmtTok(cxTotal.tokens), n: codex.length }))
    const models = groupBy(codex, modelKey)
    out.push([`| ${t('Модель')} | ${t('Токены')} | ${t('Доля')} |`, '|---|---:|---:|',
      ...models.map(([m, s]) => `| ${md(m)} | ${fmtTok(s.tokens)} | ${pct(s.tokens, cxTotal.tokens)} |`)].join('\n'))
  }

  // --- Sessions and commits ---
  const byClaude = new Map(groupBy(claude, e => e.cwd))
  const byCodex = new Map(groupBy(codex, e => e.cwd))
  const folders = new Set([...byClaude.keys(), ...byCodex.keys(), ...d.activeSessions().map(s => s.projectKey)].filter(Boolean))
  const rows: { cost: number; tokens: number; row: string; commits: string[]; who: string }[] = []
  for (const dir of folders) {
    const c = byClaude.get(dir)
    const x = byCodex.get(dir)
    const commits = (await commitsSince(dir, p.start, p.end)) ?? []
    if (!c && !x && !commits.length) continue
    const who = md(ownerOf(d, dir))
    rows.push({ cost: c?.cost ?? 0, tokens: x?.tokens ?? 0, who, commits,
      row: `| ${who} | ${c ? `$${c.cost.toFixed(2)}` : '—'} | ${x ? fmtTok(x.tokens) : '—'} | ${commits.length || '—'} |` })
  }
  if (rows.length) {
    rows.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
    out.push(t('## 🗂 Сессии'))
    out.push([`| ${t('Сессия')} | Claude | Codex | ${t('Коммиты')} |`, '|---|---:|---:|---:|', ...rows.slice(0, 12).map(r => r.row)].join('\n'))
    if (rows.length > 12) out.push(t('… ещё {v}', { v: rows.length - 12 }))
    const withCommits = rows.filter(r => r.commits.length)
    if (withCommits.length) {
      const body = withCommits.map(r => [`**${r.who}**`, ...r.commits.slice(0, 8).map(c => `- ${md(c.length > 90 ? c.slice(0, 89) + '…' : c)}`), ...(r.commits.length > 8 ? [t('- … ещё {v}', { v: r.commits.length - 8 })] : [])].join('\n')).join('\n\n')
      out.push(`<details><summary>${t('📝 Коммиты: {n}', { n: withCommits.reduce((n, r) => n + r.commits.length, 0) })}</summary>\n\n${body}\n\n</details>`)
    }
  }

  // --- Limits, as of now ---
  const limits = limitsLine()
  if (limits) out.push(t('## 📊 Лимиты сейчас'), md(limits.replace(/^📊 /, '')).split(' │ ').join('\n'))

  out.push(t('_Стоимость — если бы те же токены шли через API; подписка оплачивается фиксированно. /reports — настройки._'))
  return { markdown: out.join('\n\n'), png }
}

/**
 * Send it as one rich message, the chart inside. False when rich messages
 * are not available: the caller falls back to the photo and the text.
 */
export async function sendDaily(d: Daemon, chatId: string, p: Period, thread?: number): Promise<boolean> {
  const r = await buildDaily(d, p)
  try {
    // grammY does not upload a file nested in rich_message.media: the multipart request is built here.
    const form = new FormData()
    form.set('chat_id', chatId)
    if (thread != null) form.set('message_thread_id', String(thread))
    form.set('disable_notification', 'true')
    form.set('rich_message', JSON.stringify({
      markdown: hardBreaks(r.markdown),
      ...(r.png ? { media: [{ id: 'chart', media: { type: 'photo', media: 'attach://chart_png' } }] } : {}),
    }))
    if (r.png) form.set('chart_png', new Blob([new Uint8Array(r.png)], { type: 'image/png' }), 'chart.png')
    const res = await fetch(`${settings.apiRoot ?? 'https://api.telegram.org'}/bot${d.token}/sendRichMessage`, { method: 'POST', body: form })
    const j = await res.json() as { ok: boolean; description?: string; result?: { message_id: number } }
    if (!j.ok) throw new Error(j.description ?? `HTTP ${res.status}`)
    d.log(`daily summary for ${p.start.toDateString()} sent to ${chatId}${thread != null ? `/${thread}` : ''} as ${j.result?.message_id} (${r.markdown.length} chars, chart: ${r.png ? 'yes' : 'no'})`)
    return true
  } catch (err) {
    d.log(`daily summary as a rich message failed: ${err}`)
    return false
  }
}
