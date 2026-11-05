/** Acknowledged, persistent delivery of compact period report screens. */
import { createHash } from 'crypto'
import type { Daemon } from './daemon.ts'
import type { Screen } from './menu.ts'
import { inChat } from './lang.ts'
export type ReportJob={id:string;chat:string;thread?:number;period:{kind:string;start:string;end:string};text:string;keyboard:unknown;status:'pending'|'sent'|'cancelled';attempts:number;nextAttempt:number;messageId?:number;view?:{id:string;[key:string]:unknown}}
const key=(id:string)=>`report:job:${id}`
export function queueReport(d:Daemon,chat:string,thread:number|undefined,period:ReportJob['period'],screen:Screen):ReportJob{
  const id=createHash('sha256').update(JSON.stringify({chat,thread:thread??0,period})).digest('hex').slice(0,24)
  const existing=d.store.get(key(id));if(existing)return JSON.parse(existing)
  const job:ReportJob={id,chat,thread,period,text:screen.text,keyboard:screen.kb,status:'pending',attempts:0,nextAttempt:0}
  const viewId=JSON.stringify(screen.kb).match(/uv:([a-f0-9]+):/)?.[1]
  if(viewId){const saved=d.store.get(`usage:view:${viewId}`);if(saved)job.view=JSON.parse(saved)}
  d.store.set(key(id),JSON.stringify(job));return job
}
const running=new WeakMap<Daemon,Set<string>>()
export async function flushReportQueue(d:Daemon,now=Date.now()):Promise<void>{
  let locks=running.get(d);if(!locks){locks=new Set();running.set(d,locks)}
  for(const k of d.store.keys('report:job:')){
    const job:ReportJob=JSON.parse(d.store.get(k)!)
    if(job.status!=='pending'||job.nextAttempt>now||locks.has(job.id))continue
    locks.add(job.id)
    try{
      if(job.view)d.store.set(`usage:view:${job.view.id}`,JSON.stringify({...job.view,at:now}))
      const sent=await inChat(d,job.chat,job.thread,()=>d.bot.api.sendMessage(job.chat,job.text,{parse_mode:'HTML',message_thread_id:job.thread,disable_notification:true,link_preview_options:{is_disabled:true},reply_markup:job.keyboard as never}))
      job.status='sent';job.messageId=sent.message_id;delete job.view
    }catch(err){job.attempts++;job.nextAttempt=now+Math.min(300_000,1000*2**Math.min(job.attempts,8));d.log(`report delivery ${job.id}: ${err}`)}
    finally{d.store.set(k,JSON.stringify(job));locks.delete(job.id)}
  }
}
