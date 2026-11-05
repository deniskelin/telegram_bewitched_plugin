import { queueReport, flushReportQueue } from './reportqueue.ts'
import { usageScreen } from './usage.ts'
import { readAnalytics, totalText, rangeText } from './analytics.ts'
import { total, rangeRecords, type Range } from '../core/analytics.ts'
/**
 * Period reports to the owner: the day (by hour), the week (by day) and the
 * month (by week), sent when the period ends, each switched on or off in
 * /reports. A chart of spend plus text: totals against the previous period,
 * models, sessions, commits, the peak and the current limits.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { can, owner } from '../access.ts'
import { escapeHtml } from '../format.ts'
import { columnChartSvg, svgToPng, type Column } from './chart.ts'
import type { Daemon } from './daemon.ts'
import { button } from './stream.ts'
import { locale, k, t } from '../i18n/index.ts'
import { noticeTarget, journalChat } from './journal.ts'
import { inChat } from './lang.ts'
import { settings } from '../config.ts'

export type Kind = 'day' | 'week' | 'month'
const KINDS: Kind[] = ['day', 'week', 'month']
const KIND_NAME: Record<Kind, string> = { day: k('за сутки'), week: k('за неделю'), month: k('за месяц') }
const WEEKDAYS = [k('Пн'), k('Вт'), k('Ср'), k('Чт'), k('Пт'), k('Сб'), k('Вс')]

// --------------------------------------------------------------------------
// Periods (local time)
// --------------------------------------------------------------------------

export type Period = { kind: Kind; start: Date; end: Date }

export function midnight(t: Date): Date {
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
    for(let at=+p.start;at<+p.end;at+=3600_000){
      out.push({label:new Date(at).toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit',timeZoneName:'short'}),start:at,end:Math.min(at+3600_000,+p.end)})
    }
  } else if (p.kind === 'week') {
    for (let i = 0; i < 7; i++) {
      const s = new Date(p.start); s.setDate(s.getDate() + i)
      const e = new Date(p.start); e.setDate(e.getDate() + i + 1)
      out.push({ label: `${t(WEEKDAYS[i])} ${s.getDate()}`, start: s.getTime(), end: e.getTime() })
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
  const dm = (t: Date) => t.toLocaleDateString(locale(), { day: 'numeric', month: 'long' })
  if (p.kind === 'day') return `${dm(p.start)}, ${p.start.toLocaleDateString(locale(), { weekday: 'long' })}`
  if (p.kind === 'week') return `${dm(p.start)} — ${dm(new Date(p.end.getTime() - 1))}`
  const m = p.start.toLocaleDateString(locale(), { month: 'long', year: 'numeric' }).replace(' г.', '') // i18n-ignore: the Russian locale's year suffix
  return m[0].toUpperCase() + m.slice(1)
}

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------

function change(cur: number, prev: number, word: string): string {
  if (prev <= 0) return ''
  const pct = Math.round(((cur - prev) / prev) * 100)
  return pct === 0 ? t(' · как {word}', { word }) : t(' · {v} {v2}% к {word}', { v: pct > 0 ? '▲' : '▼', v2: Math.abs(pct), word })
}

const PREV_WORD: Record<Kind, string> = { day: k('прошлому дню'), week: k('прошлой неделе'), month: k('прошлому месяцу') }

export type Report = { caption: string; text: string; png: Buffer | null; svg: string }

export async function buildReport(d: Daemon, p: Period): Promise<Report> {
  const prev = previous(p)
  const range:Range={kind:p.kind==='day'?'d':p.kind==='week'?'w':'m',mode:'previous',start:+p.start,end:+p.end,comparisonStart:+prev.start,comparisonEnd:Math.min(+prev.end,+prev.start+(+p.end-+p.start)),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}
  const stats=readAnalytics(d,range)
  const rows=buckets(p).map(b=>({...b,total:total(rangeRecords(stats.records,{start:b.start,end:b.end}))}))
  const metric=stats.total.unpriced?'tokens':'cost'
  const cols:Column[]=rows.map(b=>({label:b.label,value:b.total[metric]}))
  const title=t('Расход {v} · {v2}',{v:t(KIND_NAME[p.kind]),v2:periodTitle(p)})
  const subtitle=`${totalText(stats.total)} · ${rangeText(range)}`
  const svg=columnChartSvg({title,subtitle,columns:cols,labelEvery:p.kind==='day'?3:1,metric})
  const png=await svgToPng(svg)
  const active=rows.filter(b=>b.total.requests>0).length
  const before=stats.before
  const lines=[t('📊 <b>Статистика {v}</b> · {v2}',{v:t(KIND_NAME[p.kind]),v2:escapeHtml(periodTitle(p))}),escapeHtml(rangeText(range)),totalText(stats.total),t('🔁 Ответов модели: {length}{v}',{length:stats.total.requests,v:change(stats.total.requests,before.requests,t(PREV_WORD[p.kind]))}),`${t(p.kind==='day'?k('Активных часов'):p.kind==='week'?k('Активных дней'):k('Активных недель'))}: ${active} / ${rows.length}`]
  for(const engine of stats.engines)lines.push(`<b>${engine.key==='claude'?'Claude':'Codex'}</b>: ${totalText(engine.total)}`)
  if(!stats.records.length)lines.push(t('Нет записей за период'))
  if(stats.models.length)lines.push('',t('🧠 <b>Модели</b>'),...stats.models.map(g=>`${escapeHtml(g.key)}: ${totalText(g.total)}`))
  if(stats.projects.length)lines.push('',t('Проекты и пользователи'),...stats.projects.map(g=>`${escapeHtml(g.label)}: ${totalText(g.total)}`))
  lines.push('',t('Оценка API, не списание подписки'))
  return{caption:`📊 ${escapeHtml(title)}`,text:lines.join('\n'),png,svg}

}

// --------------------------------------------------------------------------
// Settings and schedule
// --------------------------------------------------------------------------

export function reportSettings(d: Daemon): Record<Kind, boolean> {
  // The day's summary replaced the DIGEST_AT digest: on unless DIGEST_AT=off, until switched in /reports.
  const base = { day: settings.digestOn, week: false, month: false }
  try {
    return { ...base, ...JSON.parse(d.store.get('reports') ?? '{}') }
  } catch {
    return base
  }
}

/** Persist a compact completed-period screen; details and charts stay on demand. */
async function periodScreen(d:Daemon,chat:string,p:Period,thread?:number){
  const prev=previous(p),range:Range={kind:p.kind==='day'?'d':p.kind==='week'?'w':'m',mode:'previous',start:+p.start,end:+p.end,comparisonStart:+prev.start,comparisonEnd:Math.min(+prev.end,+prev.start+(+p.end-+p.start)),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}
  return usageScreen(d,{chatId:chat,threadId:thread},range.kind,Date.now(),'previous',range)
}
async function sendPeriod(d:Daemon,chat:string,p:Period,thread?:number):Promise<void>{
  const screen=await periodScreen(d,chat,p,thread)
  await d.bot.api.sendMessage(chat,screen.text,{parse_mode:'HTML',message_thread_id:thread,reply_markup:screen.kb,disable_notification:true})
}

const sentKey = (p: Period) => `report_sent:${p.kind}:${p.end.toISOString()}`

/** Switching a report on doesn't send the period that already ended: the next one is the first. */
export function setReport(d: Daemon, kind: Kind, on: boolean): void {
  d.store.set('reports', JSON.stringify({ ...reportSettings(d), [kind]: on }))
  if(on)d.store.set(sentKey(lastPeriod(kind)),'1')
  else for(const key of d.store.keys('report:job:')){const job=JSON.parse(d.store.get(key)!);if(job.period.kind===kind&&job.status==='pending'){job.status='cancelled';d.store.set(key,JSON.stringify(job))}}
}

/** Send the reports whose period has ended and that are switched on. */
const reportRuns=new WeakMap<Daemon,Set<string>>()
export async function sendDueReports(d:Daemon,now=new Date()):Promise<void>{
  if(!owner())return
  let running=reportRuns.get(d);if(!running){running=new Set();reportRuns.set(d,running)}
  for(const kind of KINDS){
    if(!reportSettings(d)[kind])continue
    const p=lastPeriod(kind,now),legacy=sentKey(p)
    if(d.store.get(legacy)||running.has(legacy))continue
    running.add(legacy)
    try{
      const to=await noticeTarget(d,'reports');if(!to)continue
      const period={kind,start:p.start.toISOString(),end:p.end.toISOString()}
      // Avoid rebuilding a snapshot while retrying the same destination and period.
      const exists=d.store.keys('report:job:').some(k=>{const j=JSON.parse(d.store.get(k)!);return j.chat===to.chat&&(j.thread??0)===(to.thread??0)&&j.period.kind===kind&&j.period.end===period.end})
      if(!exists)queueReport(d,to.chat,to.thread,period,await periodScreen(d,to.chat,p,to.thread))
    }catch(err){d.log(`report ${kind} preparation: ${err}`)}finally{running.delete(legacy)}
  }
  await flushReportQueue(d,+now)
}

export function startReports(d: Daemon): void {
  setInterval(() => void sendDueReports(d).catch(err => d.log(`reports failed: ${err}`)), 60_000).unref?.()
}

// --------------------------------------------------------------------------
// /reports
// --------------------------------------------------------------------------

const WHEN: Record<Kind, string> = { day: k('в 00:00 за прошедшие сутки'), week: k('в понедельник за прошлую неделю'), month: k('1-го числа за прошлый месяц') }

export function reportsScreen(d: Daemon): { text: string; kb: InlineKeyboard } {
  const on = reportSettings(d)
  const lines = [t('📊 <b>Отчёты о потреблении</b>'), t('Краткий отчёт приходит после окончания периода. График и таблицы — в подробностях.'), '']
  lines.push(t('Часовой пояс: {zone}',{zone:Intl.DateTimeFormat().resolvedOptions().timeZone}),t('Получатель: {target}',{target:journalChat(d)??owner()??'—'}))
  for (const k of KINDS) lines.push(`${on[k] ? '✅' : '⬜️'} ${t(KIND_NAME[k])[0].toUpperCase() + t(KIND_NAME[k]).slice(1)} — ${t(WHEN[k])}`)
  const kb = new InlineKeyboard([
    KINDS.map(k => button(`${on[k] ? '✅' : '⬜️'} ${k === 'day' ? t('День') : k === 'week' ? t('Неделя') : t('Месяц')}`, `rp:t:${k}`, on[k] ? 'success' : undefined)),
    KINDS.map(k => button(`📨 ${k === 'day' ? t('Вчера') : k === 'week' ? t('Прошл. неделя') : t('Прошл. месяц')}`, `rp:now:${k}`)),
    [button(t('« Статистика'), 'hub:stats')],
  ])
  return { text: lines.join('\n'), kb }
}

export function registerReportCommands(d: Daemon, bot: Bot): void {
  bot.command('reports', async ctx => {
    if (ctx.chat?.type !== 'private' || !can(ctx.from!.id, 'control')) return
    const { text, kb } = reportsScreen(d)
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb })
  })
}

export async function handleReportCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^rp:(t|now):(day|week|month)$/.exec(data)
  if (!m) return false
  if (!ctx.from || !can(ctx.from.id, 'control')) {
    await ctx.answerCallbackQuery({ text: t('Нет доступа.') }).catch(() => {})
    return true
  }
  const kind = m[2] as Kind
  if (m[1] === 't') {
    const on = !reportSettings(d)[kind]
    setReport(d, kind, on)
    await ctx.answerCallbackQuery({ text: t('{v} отчёт {v2}', { v: on ? t('✅ Включён') : t('⬜️ Выключен'), v2: t(KIND_NAME[kind]) }) }).catch(() => {})
    const { text, kb } = reportsScreen(d)
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
    return true
  }
  await ctx.answerCallbackQuery({ text: t('📨 Собираю отчёт…') }).catch(() => {})
  const message=ctx.callbackQuery?.message
  const thread=message&&'message_thread_id'in message?message.message_thread_id:undefined
  await sendPeriod(d,String(ctx.chat!.id),lastPeriod(kind),thread)
  return true
}
