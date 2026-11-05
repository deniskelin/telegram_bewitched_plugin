/** A guarded trend estimate over actual observations in one quota window. */
export type QuotaSample={at:number;percent:number;resetAt:number}
export function forecastQuota(samples:QuotaSample[],now:number):number|null{
  const last=samples.at(-1);if(!last||last.resetAt<=now||now-last.at>5*60_000)return null
  const points=samples.filter(p=>p.resetAt===last.resetAt&&p.at>=now-6*3600_000)
  if(points.length<4||last.at-points[0]!.at<15*60_000)return null
  let positive=0
  for(let i=1;i<points.length;i++){if(points[i]!.percent<points[i-1]!.percent||points[i]!.at<=points[i-1]!.at||points[i]!.at-points[i-1]!.at>30*60_000)return null;if(points[i]!.percent>points[i-1]!.percent)positive++}
  if(positive<3||last.percent>=100)return null
  const origin=points[0]!.at,x=points.map(p=>(p.at-origin)/60_000),y=points.map(p=>p.percent)
  const mx=x.reduce((a,b)=>a+b,0)/x.length,my=y.reduce((a,b)=>a+b,0)/y.length
  const xx=x.reduce((s,v)=>s+(v-mx)**2,0),xy=x.reduce((s,v,i)=>s+(v-mx)*(y[i]!-my),0)
  const slope=xy/xx;if(!(slope>0))return null
  const residual=x.reduce((s,v,i)=>s+(y[i]!-(my+slope*(v-mx)))**2,0),variance=y.reduce((s,v)=>s+(v-my)**2,0)
  if(!variance||1-residual/variance<.8)return null
  const ms=(100-last.percent)/slope*60_000
  return ms>0&&now+ms<last.resetAt?ms:null
}
