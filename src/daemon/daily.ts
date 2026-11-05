import { usageScreen } from './usage.ts'
import { readAnalytics, totalText, rangeText } from './analytics.ts'
import { total, rangeRecords, type Range } from '../core/analytics.ts'
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
import { columnChartSvg, svgToPng, type Column } from './chart.ts'
import type { Daemon } from './daemon.ts'
import { commitsSince } from './git.ts'
import { limitsLine, ownerOf } from './usage.ts'
import { buckets, midnight, type Period } from './reports.ts'
import { locale, t } from '../i18n/index.ts'
import { hardBreaks } from '../rich.ts'

/** Text from folders, models and commit subjects inside rich Markdown. */
export function md(s: string): string {
  return s.replace(/([\\`*_[\]|<>#~])/g, '\\$1')
}

/** Today from midnight to now: what /digest shows. */
export function todaySoFar(now = new Date()): Period {
  return { kind: 'day', start: midnight(now), end: now }
}

export type Daily = { markdown: string; png: Buffer | null }

export async function buildDaily(d: Daemon, p: Period): Promise<Daily> {
  const previous=new Date(p.start);previous.setDate(previous.getDate()-1)
  const range:Range={kind:'d',mode:'current',start:+p.start,end:+p.end,comparisonStart:+previous,comparisonEnd:Math.min(+p.start,+previous+(+p.end-+p.start)),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}
  const stats=readAnalytics(d,range)
  const dayEnd=new Date(p.start);dayEnd.setDate(dayEnd.getDate()+1)
  const cols=buckets({...p,end:dayEnd}).map(b=>({label:b.label,value:total(rangeRecords(stats.records,{start:b.start,end:b.end})).tokens}))
  const out=[`# 🌙 ${t('Итоги дня')}`,'---',md(rangeText(range)),md(totalText(stats.total))]
  let png:Buffer|null=null
  if(stats.records.length){png=await svgToPng(columnChartSvg({title:t('Токены'),subtitle:rangeText(range),columns:cols,metric:'tokens',labelEvery:3}));if(png)out.push('![](tg://photo?id=chart)')}
  else out.push(t('Нет записей за период'))
  for(const engine of stats.engines)out.push(`## ${engine.key==='claude'?'🟠 Claude':'⚫️ Codex'}`,md(totalText(engine.total)))
  if(stats.models.length)out.push(`## ${t('Модели')}`,...stats.models.map(g=>`- ${md(g.key)}: ${md(totalText(g.total))}`))
  const active=buckets({...p,end:dayEnd}).filter(b=>rangeRecords(stats.records,{start:b.start,end:b.end}).length>0).length
  out.push(`${t('Активных часов')}: ${active}`)
  if(stats.projects.length)out.push(`## ${t('Проекты и пользователи')}`,...stats.projects.map(g=>`- ${md(g.label)}: ${md(totalText(g.total))}`))
  const folders=new Set([...stats.projects.map(g=>g.key),...d.activeSessions().map(s=>s.projectKey)])
  const commits:string[]=[]
  for(const dir of folders){const rows=await commitsSince(dir,p.start,p.end);if(rows?.length)commits.push(`**${md(ownerOf(d,dir))}**`,...rows.map(c=>`- ${md(c)}`))}
  if(commits.length)out.push(`<details><summary>${t('Коммиты')}</summary>\n\n${commits.join('\n')}\n\n</details>`)
  const limits=limitsLine();if(limits)out.push(`## ${t('Лимиты')}`,md(limits))
  out.push(md(t('Оценка API, не списание подписки')))
  return{markdown:out.join('\n\n'),png}
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
    const previous=new Date(p.start);previous.setDate(previous.getDate()-1)
    const range:Range={kind:'d',mode:'current',start:+p.start,end:+p.end,comparisonStart:+previous,comparisonEnd:Math.min(+p.start,+previous+(+p.end-+p.start)),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}
    const screen=await usageScreen(d,{chatId,threadId:thread},'d',Date.now(),'current',range)
    await d.bot.api.sendMessage(chatId,screen.text,{parse_mode:'HTML',message_thread_id:thread,reply_markup:screen.kb,disable_notification:true})
    return true
  }
}
