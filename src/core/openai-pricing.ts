/** Published Standard API equivalents, checked 2026-11-05.
 * https://developers.openai.com/api/docs/pricing and linked model cards.
 * Never infer a rate from a vaguely similar model name. Cache writes absent
 * from CLI logs and tool/regional surcharges cannot be reconstructed here. */
export const OPENAI_PRICE_DATE='2026-11-05'
const rates:Record<string,[number,number,number]>={
  'gpt-6-astra':[10,1,50], 'gpt-6.1-sol':[2,.1,10], 'gpt-6.1-terra':[1,.05,5], 'gpt-6-luna':[.1,.01,.5],
  'gpt-5.3-codex':[1.75,.175,14], 'gpt-5.2-codex':[1.75,.175,14], 'gpt-5.1-codex':[1.25,.125,10], 'gpt-5-codex':[1.25,.125,10],
}
export function openaiCost(e:{model:string;input:number;read:number;output:number;serviceTier?:string}):number|null{
  const name=e.model.replace(/-\d{4}-\d{2}-\d{2}$/,'')
  const rate=rates[name];if(!rate)return null
  const tier=e.serviceTier??'default'
  if(['fast','priority'].includes(tier)&&!name.startsWith('gpt-6')&&name!=='gpt-5.3-codex')return null
  if(['batch','flex'].includes(tier)&&!name.startsWith('gpt-6'))return null
  const factor=({default:1,auto:1,standard:1,fast:2,priority:2,flex:.5,batch:.5} as Record<string,number>)[tier]
  if(factor===undefined)return null
  const long=name.startsWith('gpt-6')&&e.input+e.read>272_000
  return ((e.input*rate[0]+e.read*rate[1])*(long?2:1)+e.output*rate[2]*(long?1.5:1))*factor/1e6
}
