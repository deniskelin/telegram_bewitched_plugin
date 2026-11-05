import { observeQuota } from './quotahistory.ts'
import { fmtDuration } from '../format.ts'
import { OPENAI_PRICE_DATE } from '../core/openai-pricing.ts'
/** Consistent, compact views over the shared statistics snapshot. */
import { escapeHtml } from '../format.ts'
import { t } from '../i18n/index.ts'
import type { Daemon } from './daemon.ts'
import type { Range } from '../core/analytics.ts'
import { readAnalytics, totalText, rangeText, bucketStats, type Snapshot, projectId } from './analytics.ts'
import { collectCodex } from './codexusage.ts'
import { fetchLimits, lastLimits, freshCodexLimits, limitText, freshness, fmtTok } from './usage.ts'
import { htmlPages } from '../core/html-pages.ts'
export type AnalyticsContent={stats:Snapshot;summary:string;sections:Record<string,string[]>;limits:{label:string;percent:number;resetsAt:string|null;stale?:boolean}[]}
export async function analyticsContent(d:Daemon,range:Range,plan:string|null):Promise<AnalyticsContent>{
  const limits=await fetchLimits(),codex=collectCodex(Date.now(),64).limits
  const stats=readAnalytics(d,range),q:string[]=[]
  const claudeHead=t('🟠 <b>Claude</b> · подписка: {v}',{v:plan?escapeHtml(plan):t('не найдена (вход по API-ключу или учётные данные в keychain)')})
  q.push(claudeHead)
  if(typeof limits==='string')q.push(t('Лимиты: {v}',{v:escapeHtml(limits)}))
  else q.push(...limits.items.map(l=>limitText(l)),...(limits.breakdown?[t('За неделю: {v}',{v:escapeHtml(limits.breakdown)})]:[]))
  const at=lastLimits()?.at;if(at)q.push(t('Данные источника: {at}',{at:freshness(at)}))
  const cx=freshCodexLimits(codex)
  if(codex){q.push(`<b>Codex</b> · ${escapeHtml(codex.plan??'?')}`,...cx.map(l=>limitText(l)),t('Данные источника: {at}',{at:freshness(codex.at)}))}
  for(const [source,items,observed]of [['claude',typeof limits==='string'?[]:limits.items,at],['codex',cx,codex?.at]] as const){
    for(const l of items){if(!observed)continue;const forecast=observeQuota(d,source,l,observed);q.push(`${escapeHtml(l.label)} · ${forecast?t('При текущем темпе: около {time}',{time:fmtDuration(forecast)}):t('Прогноз: недостаточно свежих данных')}`)}
  }
  q.push(t('API Standard · тарифы от {date}',{date:OPENAI_PRICE_DATE}))
  const percent=stats.before.tokens>0?`${((stats.total.tokens/stats.before.tokens-1)*100).toFixed(0)}%`:t('Нет данных')
  const header=[t('📊 <b>Подписки и расход</b>'),escapeHtml(rangeText(range)),totalText(stats.total),...stats.engines.map(g=>`<b>${g.key==='claude'?'Claude':'Codex'}</b>: ${totalText(g.total)}`),`${t('Изменение токенов')}: ${percent}`,t('Оценка API, не списание подписки')].join('\n')
  const models=[t('🧠 <b>Модели</b>'),...stats.models.map(g=>`${escapeHtml(g.key)}: ${totalText(g.total)}`)].join('\n')
  const projects=[t('Проекты и пользователи'),...stats.projects.map(g=>`${escapeHtml(g.label)}: ${totalText(g.total)}`)].join('\n')
  const users=[t('Доля наблюдаемого расхода'),...stats.users.map(g=>`${escapeHtml(g.label)}: ${stats.total.tokens?(g.total.tokens/stats.total.tokens*100).toFixed(1):0}% · ${totalText(g.total)}`)].join('\n')
  const quota=[`<b>${t('Лимиты')}</b>`,claudeHead,...(typeof limits==='string'?[t('Лимиты: {v}',{v:escapeHtml(limits)})]:limits.items.slice(0,2).map(l=>limitText(l))),...(at?[t('Данные источника: {at}',{at:freshness(at)})]:[]),...(codex?['<b>Codex</b>',...cx.slice(0,2).map(l=>limitText(l)),t('Данные источника: {at}',{at:freshness(codex.at)})]:[])].join('\n')
  const all=[header,t('Сравнение: {range}',{range:rangeText({...range,start:range.comparisonStart,end:range.comparisonEnd})}),q.join('\n'),models,projects,users].join('\n\n')
  const refs=[...(typeof limits==='string'?[]:limits.items),...cx].map(l=>({...l,resetsAt:l.resetsAt?.toISOString()??null}))
  return{stats,summary:header,sections:{quota:htmlPages(quota),summary:htmlPages(header),details:htmlPages(all),models:htmlPages(models),projects:htmlPages(projects),users:htmlPages(users),limits:htmlPages(q.join('\n'))},limits:refs}
}
export function exportStats(stats:Snapshot):Record<string,unknown>{
  return{range:stats.range,total:stats.total,comparison:stats.before,engines:stats.engines,models:stats.models,projects:stats.projects.map(({key,label,total})=>({id:projectId(key),label,total})),users:stats.users.map(({label,total})=>({label,total})),notes:['API estimates use published model rates, not subscription billing. Unknown prices are excluded from the known-price subtotal. Missing CLI cache-write/tier/tool/regional details cannot be reconstructed.','Cached tokens are a subset of input. Reasoning is a subset of output.']}
}
export function csvStats(stats:Snapshot):string{
  const quote=(x:unknown)=>{let s=String(x??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'}
  return '\uFEFF'+[['section','name','requests','tokens','input','cached','output','api_equivalent_usd','unpriced_requests'],...stats.engines.map(g=>['engine',g.key,g.total.requests,g.total.tokens,g.total.input,g.total.cached,g.total.output,g.total.cost,g.total.unpriced]),...stats.models.map(g=>['model',g.key,g.total.requests,g.total.tokens,g.total.input,g.total.cached,g.total.output,g.total.cost,g.total.unpriced]),...stats.projects.map(g=>['project',g.label,g.total.requests,g.total.tokens,g.total.input,g.total.cached,g.total.output,g.total.cost,g.total.unpriced])].map(row=>row.map(quote).join(',')).join('\r\n')
}
