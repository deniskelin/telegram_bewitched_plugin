import type { Daemon } from './daemon.ts'
import type { Limit } from './usage.ts'
import { forecastQuota, type QuotaSample } from '../core/quota-forecast.ts'
export function observeQuota(d:Daemon,source:string,limit:Limit,at:number,now=Date.now()):number|null{
  const key=`quota:history:${source}:${limit.label}`
  const samples:QuotaSample[]=JSON.parse(d.store.get(key)??'[]')
  if(!limit.stale&&limit.resetsAt&&limit.resetsAt.getTime()>now&&Number.isFinite(limit.percent)&&limit.percent>=0&&limit.percent<=100){
    const resetAt=limit.resetsAt.getTime(),last=samples.at(-1)
    if(!last||last.at!==at){const next=[...samples.filter(p=>p.resetAt===resetAt),{at,percent:limit.percent,resetAt}].slice(-96);d.store.set(key,JSON.stringify(next));return forecastQuota(next,now)}
  }
  return limit.stale?null:forecastQuota(samples,now)
}
