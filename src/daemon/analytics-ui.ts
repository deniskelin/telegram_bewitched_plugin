import { agentEmoji } from './button-emoji.ts'
import { observeQuota } from './quotahistory.ts'
import { fmtDuration } from '../format.ts'
import { OPENAI_PRICE_DATE } from '../core/openai-pricing.ts'
/** Consistent, compact views over the shared statistics snapshot. */
import { escapeHtml } from '../format.ts'
import { t, k } from '../i18n/index.ts'
import type { Daemon } from './daemon.ts'
import type { Range } from '../core/analytics.ts'
import { readAnalytics, totalText, rangeText, bucketStats, type Snapshot, projectId } from './analytics.ts'
import { collectCodex } from './codexusage.ts'
import { fetchLimits, lastLimits, freshCodexLimits, limitText, freshness, fmtTok, fmtReset, type Limit } from './usage.ts'
import { htmlPages } from '../core/html-pages.ts'
export type AnalyticsContent={stats:Snapshot;summary:string;sections:Record<string,string[]>;limits:{label:string;percent:number;resetsAt:string|null;stale?:boolean}[]}
export async function analyticsContent(d:Daemon,range:Range,plan:string|null):Promise<AnalyticsContent>{
  const limits=await fetchLimits(),codex=collectCodex(Date.now(),64).limits
  const stats=readAnalytics(d,range),q:string[]=[]
  const claudeHead=`${agentEmoji('claude')} <b>Claude Code</b> · ${plan?escapeHtml(plan):t('не найдена (вход по API-ключу или учётные данные в keychain)')}`
  q.push(claudeHead)
  if(typeof limits==='string')q.push(t('Лимиты: {v}',{v:escapeHtml(limits)}))
  else q.push(...limits.items.map(l=>limitText(l)),...(limits.breakdown?[t('За неделю: {v}',{v:escapeHtml(limits.breakdown)})]:[]))
  const at=lastLimits()?.at;if(at)q.push(t('Данные источника: {at}',{at:freshness(at)}))
  const cx=freshCodexLimits(codex)
  if(codex){q.push('',`${agentEmoji('codex')} <b>Codex</b> · ${escapeHtml(codex.plan??'?')}`,...cx.map(l=>limitText(l)),t('Данные источника: {at}',{at:freshness(codex.at)}))}
  for(const [source,items,observed]of [['claude',typeof limits==='string'?[]:limits.items,at],['codex',cx,codex?.at]] as const){
    for(const l of items){if(!observed)continue;const forecast=observeQuota(d,source,l,observed);if(forecast)q.push(`${escapeHtml(l.label)} · ${t('При текущем темпе: около {time}',{time:fmtDuration(forecast)})}`)}
  }
  q.push(t('API Standard · тарифы от {date}',{date:OPENAI_PRICE_DATE}))
  const percent=stats.before.tokens>0?`${((stats.total.tokens/stats.before.tokens-1)*100).toFixed(0)}%`:t('Нет данных')
  const header=[t('📊 <b>Подписки и расход</b>'),escapeHtml(rangeText(range)),totalText(stats.total),...stats.engines.map(g=>`${agentEmoji(g.key)} <b>${g.key==='claude'?'Claude Code':'Codex'}</b>\n${totalText(g.total)}`),`${t('Изменение токенов')}: ${percent}`,t('Оценка API, не списание подписки')].join('\n\n')
  const summary=[t('📊 <b>Подписки и расход</b>'),quotaSummary('claude',typeof limits==='string'?[]:limits.items,at),quotaSummary('codex',cx,codex?.at),header.split('\n\n').slice(1).join('\n\n')].join('\n\n')
  const models=[t('🧠 <b>Модели</b>'),...stats.models.map(g=>`${agentEmoji(g.key.split(' · ')[0]!)} <b>${escapeHtml(g.key.replace(/^(claude|codex) · /,''))}</b>\n${totalText(g.total)}`)].join('\n\n')
  const projects=[`📂 <b>${t('Проекты и пользователи')}</b>`,...stats.projects.map(g=>`<b>${escapeHtml(g.label)}</b>\n${totalText(g.total)}`)].join('\n\n')
  const users=[`👥 <b>${t('Доля наблюдаемого расхода')}</b>`,...stats.users.map(g=>`${escapeHtml(g.label)}: ${stats.total.tokens?(g.total.tokens/stats.total.tokens*100).toFixed(1):0}% · ${totalText(g.total)}`)].join('\n\n')
  const quota=[`<b>${t('Лимиты')}</b>`,claudeHead,...(typeof limits==='string'?[t('Лимиты: {v}',{v:escapeHtml(limits)})]:limits.items.slice(0,2).map(l=>limitText(l))),...(at?[t('Данные источника: {at}',{at:freshness(at)})]:[]),...(codex?[`${agentEmoji('codex')} <b>Codex</b>`,...cx.slice(0,2).map(l=>limitText(l)),t('Данные источника: {at}',{at:freshness(codex.at)})]:[])].join('\n')
  const fold=(title:string,body:string)=>`<blockquote expandable><b>${title}</b>\n${body}</blockquote>`
  const all=[header,fold(t('Сравнение: {range}',{range:rangeText({...range,start:range.comparisonStart,end:range.comparisonEnd})}),`${t('Изменение токенов')}: ${percent}`),fold(t('Лимиты'),q.join('\n')),fold(t('Модели'),models),fold(t('Проекты и пользователи'),projects),fold(t('Доля наблюдаемого расхода'),users)].join('\n\n')
  const refs=[...(typeof limits==='string'?[]:limits.items),...cx].map(l=>({...l,resetsAt:l.resetsAt?.toISOString()??null}))
  const notifications=notificationPanel(refs)
  return{stats,summary,sections:{notifications:htmlPages(notifications),quota:htmlPages(quota),summary:htmlPages(summary),details:htmlPages(all),models:htmlPages(models),projects:htmlPages(projects),users:htmlPages(users),limits:htmlPages(`📊 <b>${t('Лимиты')}</b>\n\n`+q.join('\n'))},limits:refs}
}
export function exportStats(stats:Snapshot):Record<string,unknown>{
  return{range:stats.range,total:stats.total,comparison:stats.before,engines:stats.engines,models:stats.models,projects:stats.projects.map(({key,label,total})=>({id:projectId(key),label,total})),users:stats.users.map(({label,total})=>({label,total})),notes:['API estimates use published model rates, not subscription billing. Unknown prices are excluded from the known-price subtotal. Missing CLI cache-write/tier/tool/regional details cannot be reconstructed.','Cached tokens are a subset of input. Reasoning is a subset of output.']}
}
export function csvStats(stats:Snapshot):string{
  const quote=(x:unknown)=>{let s=String(x??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'}
  return '\uFEFF'+[['section','name','requests','tokens','input','cached','output','api_equivalent_usd','unpriced_requests'],...stats.engines.map(g=>['engine',g.key,g.total.requests,g.total.tokens,g.total.input,g.total.cached,g.total.output,g.total.cost,g.total.unpriced]),...stats.models.map(g=>['model',g.key,g.total.requests,g.total.tokens,g.total.input,g.total.cached,g.total.output,g.total.cost,g.total.unpriced]),...stats.projects.map(g=>['project',g.label,g.total.requests,g.total.tokens,g.total.input,g.total.cached,g.total.output,g.total.cost,g.total.unpriced])].map(row=>row.map(quote).join(',')).join('\r\n')
}

export function notificationPanel(limits:AnalyticsContent['limits']):string{
  return [t('🔔 Уведомления').replace(/^(\S+) (.+)$/,'$1 <b>$2</b>'),...limits.map(l=>`${agentEmoji(l.label.startsWith('Codex:')?'codex':'claude')} <b>${l.label.startsWith('Codex:')?'Codex':'Claude Code'} · ${escapeHtml(l.label.replace(/^Codex:\s*/,''))}</b>\n${limitText({...l,resetsAt:l.resetsAt?new Date(l.resetsAt):null})}`)].join('\n\n')
}

/** The primary windows are selected by identity, never by their position. */
export function quotaSummary(engine:'claude'|'codex',items:Limit[],observedAt?:number,now=Date.now()):string{
  const labels=engine==='codex'?[k('Codex: 5 часов'),k('Codex: неделя')]:[k('5 часов'),k('Неделя')]
  const rows=labels.map((label,i)=>{
    const limit=items.find(l=>l.label===label)
    const name=t(i===0?k('5 часов'):k('Неделя'))
    const unknown=!limit||limit.stale||!Number.isFinite(limit.percent)||!!limit.resetsAt&&+limit.resetsAt<=now
    const value=unknown?t('Текущий лимит неизвестен'):`${t('Осталось')}: ${Math.max(0,Math.min(100,100-limit.percent)).toFixed(0)}%`
    return `${name}: <b>${value}</b>${!unknown&&limit.resetsAt?' · '+escapeHtml(fmtReset(limit.resetsAt,now)):''}`
  })
  return [`${agentEmoji(engine)} <b>${engine==='claude'?'Claude Code':'Codex'} · ${t('Лимиты')}</b>`,...rows,...(observedAt?[`<i>${t('Данные источника: {at}',{at:freshness(observedAt)})}</i>`]:[])].join('\n')
}
