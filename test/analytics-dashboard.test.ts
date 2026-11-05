import { screenToRich } from '../src/rich.ts'
import { beforeAll, afterAll, describe, test, expect } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { analyticsRange, aggregate, total, type AccountingRecord } from '../src/core/analytics.ts'
import { openaiCost } from '../src/core/openai-pricing.ts'
import { forecastQuota } from '../src/core/quota-forecast.ts'
import { Store } from '../src/db.ts'
import type { Daemon, Session } from '../src/daemon/daemon.ts'
import type { Context } from 'grammy'
import { buildReport, lastPeriod, sendDueReports, setReport, handleReportCallback } from '../src/daemon/reports.ts'
import { readAnalytics, freezeAnalytics, bucketStats } from '../src/daemon/analytics.ts'
import { freshCodexLimits, limitText, usageScreen, usageKeyboard, handleResetCallback } from '../src/daemon/usage.ts'
import { loadUsageView, saveUsageView } from '../src/daemon/usageview.ts'
import { sessionsList, handleSessionMenu } from '../src/daemon/menu.ts'
import { sessionView } from '../src/daemon/sessionview.ts'
import { mainScreen } from '../src/daemon/hub.ts'
import { queueReport, flushReportQueue } from '../src/daemon/reportqueue.ts'
import { InlineKeyboard } from 'grammy'
import { exportStats, csvStats, quotaSummary } from '../src/daemon/analytics-ui.ts'
const record=(over:Partial<AccountingRecord>={}):AccountingRecord=>({id:'one',ts:1,engine:'codex',model:'gpt-6.1-sol',cwd:'/a',input:100,read:50,output:20,write5m:0,write1h:0,apiCost:.1,...over})
describe('shared analytics and published price equivalents',()=>{
  test('known prices, cache subsets, context thresholds and unknown models/tiers',()=>{
    expect(openaiCost({model:'gpt-6.1-sol',input:100_000,read:100_000,output:1000})).toBeCloseTo(.22,8)
    expect(openaiCost({model:'gpt-6.1-sol-2026-10-01',input:200_000,read:100_000,output:1000})).toBeCloseTo(.835,8)
    expect(openaiCost({model:'gpt-6.1-sol',input:100_000,read:100_000,output:1000,serviceTier:'fast'})).toBeCloseTo(.44,8)
    expect(openaiCost({model:'gpt-5.3-codex',input:100_000,read:0,output:1000})).toBeCloseTo(.189,8)
    expect(openaiCost({model:'gpt-unknown',input:1,read:0,output:1})).toBeNull()
    expect(openaiCost({model:'gpt-6.1-sol',input:1,read:0,output:1,serviceTier:'unknown'})).toBeNull()
  })
  test('aggregate deduplication and unknown prices never remove recorded activity',()=>{
    const e=record({apiCost:null,reasoning:5}),result=total([e,e,record({id:'two',engine:'claude',apiCost:null})])
    expect(result).toMatchObject({requests:2,tokens:340,input:300,output:40,cached:100,reasoning:5,unpriced:2,cost:0})
  })
  test('rolling ranges differ explicitly from calendar periods; partial comparisons are clamped',()=>{
    const now=+new Date(2026,10,5,12),zone=Intl.DateTimeFormat().resolvedOptions().timeZone
    const week=analyticsRange('w','current',now,zone),rolling=analyticsRange('w','rolling',now,zone),month=analyticsRange('m','previous',now,zone)
    expect(new Date(week.start).getDay()).toBe(1);expect(rolling.end-rolling.start).toBe(7*86400_000)
    expect(week.start).not.toBe(rolling.start);expect(new Date(month.start).getDate()).toBe(1)
    expect(week.comparisonEnd-week.comparisonStart).toBe(week.end-week.start)
    const late=analyticsRange('m','current',+new Date(2026,2,31,23),zone)
    expect(late.comparisonEnd).toBeLessThanOrEqual(late.start)
  })
  test('forecasts require recent, monotonic, sufficiently long observations in the same window',()=>{
    const now=2_000_000,resetAt=now+4*3600_000
    const samples=[10,20,30,40].map((percent,i)=>({at:now-(3-i)*5*60_000,percent,resetAt}))
    expect(forecastQuota(samples,now)).toBeCloseTo(30*60_000)
    expect(forecastQuota(samples.slice(1),now)).toBeNull()
    expect(forecastQuota(samples,now+10*60_000)).toBeNull()
    expect(forecastQuota([...samples.slice(0,3),{...samples[3]!,percent:5}],now)).toBeNull()
    expect(forecastQuota(samples.map(s=>({...s,resetAt:now-1})),now)).toBeNull()
  })
})
const fixture='unified-dashboard-fixture',paths:string[]=[]
let previousLimits:string|undefined
beforeAll(()=>{
  previousLimits=process.env.USAGE_LIMITS;process.env.USAGE_LIMITS='off'
  const dir=join(process.env.CODEX_HOME!,'sessions','2026','10','28');mkdirSync(dir,{recursive:true});paths.push(join(dir,fixture+'.jsonl'))
  writeFileSync(paths[0]!,[
    {type:'session_meta',payload:{cwd:'/fixture/unified-project'}},{type:'turn_context',payload:{model:'gpt-6.1-sol'}},
    {timestamp:'2026-10-28T10:00:00Z',type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:20,cached_input_tokens:40}}}},
  ].map(x=>JSON.stringify(x)).join('\n'))
})
afterAll(()=>{if(previousLimits===undefined)delete process.env.USAGE_LIMITS;else process.env.USAGE_LIMITS=previousLimits;for(const p of paths)rmSync(p,{force:true})})
function setup(){
  const calls:{method:string;args:any[]}[]=[],sessions=new Map<string,Session>()
  const d={store:new Store(':memory:'),sessions,activeSessions:()=>[...sessions.values()].filter(s=>!s.passive),userSession:()=>undefined,userIdOf:()=>null,userShortName:()=> 'Owner',userLabel:(u:string)=>u,permissions:new Map(),log:()=>{},bot:{api:new Proxy({},{get:(_,method:string)=>async(...args:any[])=>{calls.push({method,args});return{message_id:77}}})}} as unknown as Daemon
  const edits:any[]=[],toasts:string[]=[]
  const ctx={from:{id:111},chat:{id:111},callbackQuery:{message:{message_id:42,chat:{id:111}}},answerCallbackQuery:async(x:any)=>{if(x?.text)toasts.push(x.text)},editMessageText:async(text:string,extra:any)=>{edits.push({text,extra})},editMessageReplyMarkup:async(extra:any)=>{edits.push({extra})},deleteMessage:async()=>{calls.push({method:'delete',args:[]})}} as unknown as Context
  return{d,ctx,calls,edits,toasts,sessions}
}
const latest=(d:Daemon)=>{const keys=d.store.keys('usage:view:');return JSON.parse(d.store.get(keys.at(-1)!)!)}
describe('consistent report/UI adapters',()=>{
  test('Codex contributes to weekly and monthly reports, including API equivalents and active intervals',async()=>{
    const {d}=setup(),now=new Date('2026-11-05T12:00:00Z')
    for(const kind of ['week','month'] as const){const r=await buildReport(d,lastPeriod(kind,now));expect(r.text).toContain('Codex');expect(r.text).toContain('unified-project');expect(r.text).not.toContain('Нет записей за период');expect(r.svg).not.toContain('Нет данных для этой метрики')}
  })
  test('unknown-price responses still count as active hours',async()=>{
    const {d}=setup(),path=join(process.env.CLAUDE_CONFIG_DIR!,'projects','unified-active','fixture.jsonl')
    mkdirSync(join(path,'..'),{recursive:true})
    writeFileSync(path,JSON.stringify({type:'assistant',timestamp:'2026-10-28T10:00:00Z',cwd:'/fixture/unknown',message:{id:'unified-active',model:'unpublished-model',usage:{input_tokens:10,output_tokens:2}}})+'\n')
    try{const report=await buildReport(d,{kind:'day',start:new Date('2026-10-28T00:00:00Z'),end:new Date('2026-10-29T00:00:00Z')});expect(report.text).toContain('Активных часов: 1');expect(report.text).toContain('Без цены: 1')}finally{rmSync(path,{force:true})}
  })
  test('primary usage summary exposes both agents and exact primary windows with honest remaining quota',async()=>{
    const now=Date.now(),reset=new Date(now+3600_000)
    const text=quotaSummary('claude',[{label:'Неделя, Opus',percent:99,resetsAt:reset},{label:'Неделя',percent:36,resetsAt:reset},{label:'5 часов',percent:31,resetsAt:reset}],now,now)
    expect(text).toContain('5 часов: <b>Осталось: 69%</b>')
    expect(text).toContain('Неделя: <b>Осталось: 64%</b>')
    expect(text).not.toContain('Opus');expect(text).toContain('сброс');expect(text).toContain('5256261335682941418')
    const unknown=quotaSummary('codex',[{label:'Codex: 5 часов',percent:76,resetsAt:new Date(now-1)}],now,now)
    expect(unknown.match(/Текущий лимит неизвестен/g)).toHaveLength(2)
    expect(unknown).not.toContain('Осталось: 100%');expect(unknown).toContain('5255760585445901285')
    const {d}=setup(),screen=await usageScreen(d,{chatId:'111'})
    expect(screen.text).toContain('Claude Code');expect(screen.text).toContain('Codex');expect(screen.text).toContain('Текущий лимит неизвестен')
    expect(screen.kb.inline_keyboard.flat()).toHaveLength(2)
  })
  test('an expired Codex observation is unknown rather than a fabricated new-window zero',()=>{
    const at=new Date(Date.now()-1000),l=freshCodexLimits({at:1,plan:'plus',items:[{label:'Codex: 5 часов',percent:76,resetsAt:at}]})[0]!
    expect(l.percent).toBe(76);expect(l.stale).toBe(true);expect(limitText(l)).toContain('неизвестен');expect(limitText(l)).not.toContain('<b>0%</b>')
  })
  test('compact reports expose details, charts and exports on demand and keep snapshots small',async()=>{
    const {d,ctx,calls}=setup();const screen=await usageScreen(d,{chatId:'111'},'m',Date.now(),'rolling')
    expect(screen.kb.inline_keyboard.flat()).toHaveLength(2)
    const v=latest(d);expect(v.stats.records).toEqual([])
    await handleResetCallback(d,ctx,`uv:${v.id}:s:details`)
    const detailed=loadUsageView(d,v.id)!;expect(detailed.section).toBe('details')
    expect(JSON.stringify(detailed.sections)).toContain('API Standard')
    await handleResetCallback(d,ctx,`uv:${v.id}:e:json`);expect(calls.some(c=>c.method==='sendDocument')).toBe(true)
    await handleResetCallback(d,ctx,`uv:${v.id}:c:tokens`);expect(calls.filter(c=>c.method==='sendPhoto')).toHaveLength(1)
    await handleResetCallback(d,ctx,`uv:${v.id}:s:summary`);expect(loadUsageView(d,v.id)?.section).toBe('summary')
  })
  test('presentation folds details, preserves custom agent icons and isolates notifications, including old snapshots',async()=>{
    const {d,ctx}=setup();await usageScreen(d,{chatId:'111'})
    const v=latest(d),reset=new Date(Date.now()+3600_000).toISOString()
    v.limits=[{label:'5 часов',percent:42,resetsAt:reset},{label:'Codex: 5 часов',percent:21,resetsAt:reset}]
    delete v.sections.notifications;saveUsageView(d,v)
    await handleResetCallback(d,ctx,`uv:${v.id}:s:details`)
    let saved=loadUsageView(d,v.id)!
    const buttons=usageKeyboard(d,saved).inline_keyboard.flat()
    expect(buttons.some(b=>'callback_data'in b&&b.callback_data.endsWith(':s:notifications'))).toBe(true)
    expect(buttons.some(b=>'callback_data'in b&&b.callback_data.includes(':a:lr:'))).toBe(false)
    const rich=screenToRich(saved.pages[0]!)!
    expect(rich).toContain('<details><summary>')
    expect(rich).toContain('5256261335682941418')
    expect(rich).not.toContain('недостаточно свежих данных')
    await handleResetCallback(d,ctx,`uv:${v.id}:s:notifications`)
    saved=loadUsageView(d,v.id)!
    const windows=usageKeyboard(d,saved).inline_keyboard.flat().filter(b=>'callback_data'in b&&b.callback_data.endsWith(':x'))
    expect(windows.map(b=>(b as {icon_custom_emoji_id?:string}).icon_custom_emoji_id)).toEqual(['5256261335682941418','5255760585445901285'])
    expect(windows.every(b=>!b.text.includes('Codex')&&!b.text.includes('Claude'))).toBe(true)
    expect(screenToRich(saved.pages[0]!)).toContain('Уведомления</h3>')
    await handleResetCallback(d,ctx,`uv:${v.id}:a:lr:1:s`)
    expect(d.store.get('limit_notify:Codex: 5 часов')).toEndWith('|silent')
    await handleResetCallback(d,ctx,`uv:${v.id}:s:details`)
    expect(loadUsageView(d,v.id)?.section).toBe('details')
  })
  test('stable project identity keeps same-basename projects separate; exports omit server paths',()=>{
    const {d}=setup(),now=Date.now(),range=analyticsRange('m','rolling',now,Intl.DateTimeFormat().resolvedOptions().timeZone)
    const empty=readAnalytics(d,range),records=[record({cwd:'/first/api'}),record({id:'two',cwd:'/second/api'})]
    expect(aggregate(records,r=>r.cwd)).toHaveLength(2)
    const frozen=freezeAnalytics({...empty,records,total:total(records)})
    expect(bucketStats(frozen).reduce((n,b)=>n+b.tokens,0)).toBe(0) // fixture timestamps are outside this range.
    const json=JSON.stringify(exportStats(frozen));expect(json).not.toContain('/first/api')
    expect(csvStats({...frozen,projects:[{key:'/hidden',label:'=formula',total:total(records)}]})).toContain("'=formula")
  })
  test('session pages expose bounded buttons, attention order, saved filters and back navigation',async()=>{
    const {d,ctx,sessions}=setup()
    for(let i=0;i<30;i++){const id=i.toString(16).padStart(8,'0');sessions.set(id,{id,cwd:`/project/${i}`,projectKey:`/project/${i}`,projectName:`Project ${i}`,sock:null as never,claudePid:null,branch:null,tmuxPane:null,lastChat:null,lastAnswer:null,answer:'',lastHookAt:0,notes:[],reconnect:false,lastTool:null,alwaysAllow:new Set(),contextWarned:false,engine:'claude',status:i===20?'waiting':i===21?'working':'idle',lastActivity:Date.now(),connectedAt:1,turn:null,stoppedAt:null,argv:[],claude:{sessionId:null,transcript:null,permissionMode:null},passive:false,topic:null,group:null} as Session)}
    const list=await sessionsList(d)
    expect(list.kb.inline_keyboard.flat().filter(b=>'callback_data'in b&&b.callback_data.startsWith('sm:s:'))).toHaveLength(7)
    expect(list.text).toContain('Подключено: 30');expect(list.text.length).toBeLessThan(4000)
    await handleSessionMenu(d,ctx,'sl:working');expect(sessionView(d,ctx)).toEqual({filter:'working',page:0})
    await handleSessionMenu(d,ctx,'sm:list');expect(sessionView(d,ctx).filter).toBe('working')
    expect(mainScreen(d).kb.inline_keyboard.flat().some(b=>'callback_data'in b&&b.callback_data==='hub:periods')).toBe(true)
  })
  test('manual calendar report keeps the original forum topic',async()=>{
    const {d,ctx,calls}=setup()
    const forum={...ctx,chat:{id:-100123},callbackQuery:{message:{message_id:1,chat:{id:-100123},message_thread_id:37,is_topic_message:true}}} as Context
    await handleReportCallback(d,forum,'rp:now:week')
    const sent=calls.find(c=>c.method==='sendMessage')!
    expect(sent.args[0]).toBe('-100123');expect(sent.args[2].message_thread_id).toBe(37)
  })
  test('persistent delivery retries, deduplicates successful sends, survives new wrappers and cancels pending jobs',async()=>{
    const {d,calls}=setup(),period={kind:'week',start:'2026-10-26',end:'2026-11-02'},screen={text:'report',kb:new InlineKeyboard([])}
    await usageScreen(d,{chatId:'111',threadId:37});const saved=latest(d)
    screen.kb=new InlineKeyboard().text('Details',`uv:${saved.id}:s:details`)
    const job=queueReport(d,'111',37,period,screen)
    d.store.set(`usage:view:${saved.id}`,null)
    let attempts=0
    Object.assign(d.bot,{api:{sendMessage:async()=>{attempts++;if(attempts===1)throw new Error('offline');return{message_id:88}}}})
    await flushReportQueue(d,1000);expect(attempts).toBe(1)
    expect(JSON.parse(d.store.get(`report:job:${job.id}`)!).status).toBe('pending')
    await flushReportQueue({...d} as Daemon,10_000);expect(attempts).toBe(2)
    expect(loadUsageView(d,saved.id)?.at).toBe(10_000)
    await flushReportQueue(d,20_000);expect(attempts).toBe(2)
    const pending=queueReport(d,'111',38,period,screen);setReport(d,'week',false)
    await flushReportQueue(d,30_000);expect(JSON.parse(d.store.get(`report:job:${pending.id}`)!).status).toBe('cancelled')
  })
})
