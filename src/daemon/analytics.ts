import { createHash } from 'crypto'
/** One read model for usage, daily and calendar reports. */
import { relative, basename } from 'path'
import { settings } from '../config.ts'
import { locale, t } from '../i18n/index.ts'
import type { Daemon } from './daemon.ts'
import { collectEntries, costOf, fmtTok, modelKey } from './usage.ts'
import { collectCodex } from './codexusage.ts'
import { aggregate, total, rangeRecords, type AccountingRecord, type Range, type Total } from '../core/analytics.ts'
export type StatsRecord=AccountingRecord & {effort?:string}
export type SeriesPoint={label:string;start:number;end:number;tokens:number;requests:number;cost:number}
export type Snapshot={series?:SeriesPoint[];range:Range;records:StatsRecord[];before:Total;total:Total;engines:{key:string;total:Total}[];models:{key:string;total:Total}[];projects:{key:string;label:string;total:Total}[];users:{key:string;label:string;total:Total}[]}
export function projectName(d:Daemon,cwd:string):string{
  if(!cwd)return t('❔ неизвестно')
  const user=/^(\d+)(\/|$)/.exec(relative(settings.usersDir,cwd))?.[1]
  if(user)return `👤 ${d.userLabel(user)}`
  const live=d.activeSessions?.().find(s=>s.cwd===cwd||s.projectKey===cwd)
  if(live?.topic?.name)return `📂 ${live.topic.name.replace(/^🗄 /,'')}`
  if(live?.group?.title)return `📂 ${live.group.title}`
  const stored=d.store.db?.query<{name:string},[string]>('SELECT name FROM topics WHERE project_key = ? ORDER BY last_activity_at DESC LIMIT 1').get(cwd)
  return `📂 ${stored?.name?.replace(/^🗄 /,'')??basename(cwd)??cwd}`
}
export function readAnalytics(d:Daemon,range:Range):Snapshot{
  const days=Math.ceil((range.end-range.comparisonStart)/86400_000)+1
  const all:StatsRecord[]=[...collectEntries(range.end,days).map(e=>({...e,engine:'claude',apiCost:costOf(e)})),...collectCodex(range.end,days).entries.map(e=>({...e,engine:'codex',apiCost:costOf(e)}))]
  const records=rangeRecords(all,range)
  const projectGroups=aggregate(records,e=>e.cwd)
  const names=new Map<string,number>();for(const g of projectGroups){const name=projectName(d,g.key);names.set(name,(names.get(name)??0)+1)}
  const userKey=(cwd:string)=>/^(\d+)(\/|$)/.exec(relative(settings.usersDir,cwd))?.[1]??'projects'
  return {range,records,total:total(records),before:total(rangeRecords(all,{start:range.comparisonStart,end:range.comparisonEnd})),engines:aggregate(records,e=>e.engine),models:aggregate(records,e=>`${e.engine} · ${modelKey(e)}`),projects:projectGroups.map(g=>({...g,label:projectName(d,g.key)+((names.get(projectName(d,g.key))??0)>1?` · ${projectId(g.key)}`:'')})),users:aggregate(records,e=>userKey(e.cwd)).map(g=>({...g,label:g.key==='projects'?t('📂 проекты'):`👤 ${d.userLabel(g.key)}`}))}
}
export function totalText(s:Total):string{return `${t('Токены')}: ${fmtTok(s.tokens)} · ${t('Ответов модели')}: ${s.requests} · ${s.requests===s.unpriced?'—':`≈$${s.cost.toFixed(2)}`}${s.unpriced?` · ${t('Без цены')}: ${s.unpriced}`:''}`}
export function rangeText(r:Range):string{
  const f=(n:number)=>new Date(n).toLocaleString(locale(),{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'})
  return `${f(r.start)} — ${f(r.end)}`
}
export function bucketStats(snapshot:Snapshot,count=12):{label:string;start:number;end:number;tokens:number;requests:number;cost:number}[]{
  if(snapshot.series&&count===snapshot.series.length)return snapshot.series
  const size=(snapshot.range.end-snapshot.range.start)/count
  return Array.from({length:count},(_,i)=>{const start=snapshot.range.start+i*size,end=start+size,s=total(rangeRecords(snapshot.records,{start,end}));return{label:new Date(start).toLocaleString(locale(),{day:'2-digit',month:'2-digit',hour:'2-digit'}),start,end,tokens:s.tokens,requests:s.requests,cost:s.cost}})
}

/** Persist aggregates and chart bins, not thousands of raw CLI requests per screen. */
export function freezeAnalytics(snapshot:Snapshot):Snapshot{return {...snapshot,series:bucketStats(snapshot),records:[]}}

export function projectId(cwd:string):string{return createHash('sha256').update(cwd).digest('hex').slice(0,8)}
