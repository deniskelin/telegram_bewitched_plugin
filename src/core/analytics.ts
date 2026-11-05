/** Shared accounting and period rules. Infrastructure supplies priced records and time. */
export type RangeKind = 'h5' | 'd' | 'w' | 'm'
export type RangeMode = 'rolling' | 'current' | 'previous'
export type Range = { kind: RangeKind; mode: RangeMode; start: number; end: number; comparisonStart: number; comparisonEnd: number; timezone: string }
export function analyticsRange(kind: RangeKind, mode: RangeMode, now: number, timezone: string): Range {
  const date = new Date(now), start = new Date(now)
  if (kind === 'h5' || mode === 'rolling') {
    const length = ({ h5: 5/24, d: 1, w: 7, m: 30 }[kind])*86400_000
    return {kind,mode:'rolling',start:now-length,end:now,comparisonStart:now-2*length,comparisonEnd:now-length,timezone}
  }
  start.setHours(0,0,0,0)
  if (kind === 'w') start.setDate(start.getDate()-(start.getDay()+6)%7)
  if (kind === 'm') start.setDate(1)
  const previous = new Date(start)
  if (kind === 'm') previous.setMonth(previous.getMonth()-1)
  else previous.setDate(previous.getDate()-(kind === 'w'?7:1))
  if (mode === 'previous') {
    const earlier = new Date(previous)
    if (kind === 'm') earlier.setMonth(earlier.getMonth()-1)
    else earlier.setDate(earlier.getDate()-(kind === 'w'?7:1))
    return {kind,mode,start:+previous,end:+start,comparisonStart:+earlier,comparisonEnd:+previous,timezone}
  }
  return {kind,mode,start:+start,end:now,comparisonStart:+previous,comparisonEnd:Math.min(+start,+previous+(now-+start)),timezone}
}
export type AccountingRecord = { id:string; ts:number; engine:string; model:string; cwd:string; input:number; read:number; output:number; write5m:number; write1h:number; reasoning?:number; apiCost:number|null }
export type Total = { requests:number; tokens:number; input:number; output:number; cached:number; cacheCreated:number; reasoning:number; cost:number; unpriced:number }
export function total(records:AccountingRecord[]):Total {
  const out:Total={requests:0,tokens:0,input:0,output:0,cached:0,cacheCreated:0,reasoning:0,cost:0,unpriced:0}
  const seen=new Set<string>()
  for(const e of records){const id=`${e.engine}:${e.id}`;if(seen.has(id))continue;seen.add(id)
    out.requests++;out.input+=e.input+e.read+e.write5m+e.write1h;out.output+=e.output;out.cached+=e.read;out.cacheCreated+=e.write5m+e.write1h;out.reasoning+=e.reasoning??0
    if(e.apiCost===null)out.unpriced++;else out.cost+=e.apiCost
  }
  out.tokens=out.input+out.output;return out
}
export function aggregate(records:AccountingRecord[],key:(e:AccountingRecord)=>string):{key:string;total:Total}[]{
  const groups=new Map<string,AccountingRecord[]>()
  for(const e of records){const k=key(e),items=groups.get(k)??[];items.push(e);groups.set(k,items)}
  return [...groups].map(([key,items])=>({key,total:total(items)})).sort((a,b)=>b.total.tokens-a.total.tokens||a.key.localeCompare(b.key))
}
export function rangeRecords<T extends AccountingRecord>(records:T[],range:Pick<Range,'start'|'end'>):T[]{return records.filter(e=>e.ts>=range.start&&e.ts<range.end)}
