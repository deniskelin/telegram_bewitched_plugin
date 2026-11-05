import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { Store } from '../src/db.ts'
import type { Daemon } from '../src/daemon/daemon.ts'
import type { Context } from 'grammy'
import { htmlPages } from '../src/core/html-pages.ts'
import { usageScreen, handleResetCallback, renderUsageView } from '../src/daemon/usage.ts'
import { loadUsageView, saveUsageView, type UsageView } from '../src/daemon/usageview.ts'

function balanced(html:string) {
  const stack:string[]=[]
  for(const m of html.matchAll(/<(\/?)([\w-]+)[^>]*>/g)) { if(m[1]) expect(stack.pop()).toBe(m[2]);else stack.push(m[2]!) }
  expect(stack).toEqual([])
}
const plain=(html:string)=>html.replace(/<[^>]*>/g,'')
describe('HTML page boundaries',()=>{
  test('preserves long escaped lines, quotes, graphemes and every item',()=>{
    const emoji='👩🏽‍💻'
    const html='<b>Report</b>\n<blockquote expandable>'+Array.from({length:90},(_,i)=>`item-${i}: ${emoji} &amp; &lt; ${'x'.repeat(100)}\n`).join('')+'</blockquote>'
    const pages=htmlPages(html,512)
    expect(pages.length).toBeGreaterThan(10)
    expect(pages.map(plain).join('')).toBe(plain(html))
    for(const p of pages){expect(p.length).toBeLessThanOrEqual(512);balanced(p);expect(p).not.toMatch(/&(?:amp|lt)?$/)}
    expect(pages.join('')).toContain(emoji)
  })
  test('one oversized model line splits without losing characters',()=>{
    const html='<blockquote><b>'+('😀&amp;'.repeat(3000))+'</b></blockquote>'
    const pages=htmlPages(html)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.map(plain).join('')).toBe(plain(html))
    for(const p of pages){balanced(p);expect(p.length).toBeLessThanOrEqual(3600);expect(p).not.toMatch(/[\uD800-\uDBFF]<\//)}
  })
})
const fixtureDir=join(process.env.CLAUDE_CONFIG_DIR!,'projects','usage-pages-fixture')
let previous:string|undefined
beforeAll(()=>{
  previous=process.env.USAGE_LIMITS;process.env.USAGE_LIMITS='off'
  mkdirSync(fixtureDir,{recursive:true})
  for(let i=0;i<60;i++)writeFileSync(join(fixtureDir,`${i}.jsonl`),JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),cwd:`/fixture/page-owner-${String(i).padStart(3,'0')}`,message:{id:`page-${i}`,model:`page-model-${String(i).padStart(3,'0')}-`+'long-name-'.repeat(5),usage:{input_tokens:100,output_tokens:10}}})+'\n')
})
afterAll(()=>{if(previous===undefined)delete process.env.USAGE_LIMITS;else process.env.USAGE_LIMITS=previous;rmSync(fixtureDir,{recursive:true,force:true})})
function setup(){
  const d={store:new Store(':memory:'),userLabel:(u:string)=>u,log:()=>{}} as unknown as Daemon
  const edits:{text:string;extra:any}[]=[],toasts:string[]=[]
  const ctx={from:{id:111},chat:{id:111},callbackQuery:{message:{message_id:42,chat:{id:111}}},answerCallbackQuery:async(o:any)=>{if(o?.text)toasts.push(o.text)},editMessageText:async(text:string,extra:any)=>{edits.push({text,extra})},editMessageReplyMarkup:async(extra:any)=>{edits.push({text:'markup',extra})}} as unknown as Context
  return {d,ctx,edits,toasts}
}
const viewOf=(d:Daemon):UsageView=>JSON.parse(d.store.get(d.store.keys('usage:view:').at(-1)!)!)
describe('durable usage pagination',()=>{
  test('all models and owners remain reachable; pages fit, are balanced and edit one message',async()=>{
    const {d,ctx,edits}=setup()
    const screen=await usageScreen(d,{chatId:'111'})
    const v=viewOf(d)
    expect(v.pages.length).toBeGreaterThan(1)
    expect(screen.text).toContain('Страница 1 из')
    const all=v.pages.map(plain).join('')
    for(let i=0;i<60;i++){const id=String(i).padStart(3,'0');expect(all).toContain(`page-model-${id}-`);expect(all).toContain(`page-owner-${id}:`)}
    for(const p of v.pages){expect(p.length).toBeLessThanOrEqual(3600);balanced(p)}
    await handleResetCallback(d,ctx,`uv:${v.id}:g:1`)
    expect(edits).toHaveLength(1);expect(edits[0]!.text).toContain('Страница 2 из')
    expect(loadUsageView(d,v.id)?.page).toBe(1)
  })
  test('navigation survives reconstruction, clamps boundaries and settings retain the page',async()=>{
    const {d,ctx,edits}=setup();await usageScreen(d,{chatId:'111'})
    const v=viewOf(d), restarted={...d} as Daemon
    await handleResetCallback(restarted,ctx,`uv:${v.id}:g:999999`)
    expect(loadUsageView(d,v.id)?.page).toBe(v.pages.length-1)
    await handleResetCallback(restarted,ctx,`uv:${v.id}:a:us:w:off`)
    expect(JSON.stringify(edits.at(-1)!.extra)).toContain(`uv:${v.id}:g:`)
    expect(loadUsageView(d,v.id)?.page).toBe(v.pages.length-1)
    await handleResetCallback(d,ctx,`uv:${v.id}:g:0`)
    expect(loadUsageView(d,v.id)?.page).toBe(0)
  })
  test('each view keeps its period; page navigation uses its stored snapshot',async()=>{
    const {d,ctx}=setup();await usageScreen(d,{chatId:'111'},'w');const first=viewOf(d)
    const keys=new Set(d.store.keys('usage:view:'))
    await usageScreen(d,{chatId:'111'},'h5');const second=JSON.parse(d.store.get(d.store.keys('usage:view:').find(k=>!keys.has(k))!)!) as UsageView
    await handleResetCallback(d,ctx,`uv:${first.id}:p:m`)
    expect(loadUsageView(d,first.id)?.period).toBe('m');expect(loadUsageView(d,second.id)?.period).toBe('h5')
    expect(d.store.get('usage_period')).toBeNull()
    const snapshot=loadUsageView(d,first.id)!.pages
    await handleResetCallback(d,ctx,`uv:${first.id}:g:1`)
    expect(loadUsageView(d,first.id)!.pages).toEqual(snapshot)
    await handleResetCallback(d,ctx,`uv:${first.id}:r`)
    expect(loadUsageView(d,first.id)?.period).toBe('m')
  })
  test('wrong chats/topics/users and expired snapshots cannot expose report pages',async()=>{
    const {d,ctx,edits,toasts}=setup();await usageScreen(d,{chatId:'111',threadId:37});const v=viewOf(d)
    await handleResetCallback(d,ctx,`uv:${v.id}:g:1`);expect(edits).toHaveLength(0)
    await handleResetCallback(d,{...ctx,chat:{id:222}} as Context,`uv:${v.id}:g:1`);expect(edits).toHaveLength(0)
    await handleResetCallback(d,{...ctx,from:{id:222}} as Context,`uv:${v.id}:g:1`);expect(edits).toHaveLength(0)
    v.threadId=undefined;v.at=Date.now()-8*86400_000;saveUsageView(d,v)
    await handleResetCallback(d,ctx,`uv:${v.id}:g:1`);expect(edits).toHaveLength(0);expect(toasts.at(-1)).toContain('устарел')
  })
})


test('an expired limit in a still-valid snapshot cannot schedule an obsolete reset notice',async()=>{
  const {d,ctx,toasts}=setup();await usageScreen(d,{chatId:'111'});const v=viewOf(d)
  v.limits=[{label:'5 часов',percent:50,resetsAt:new Date(Date.now()-1000).toISOString()}];saveUsageView(d,v)
  await handleResetCallback(d,ctx,`uv:${v.id}:a:lr:0:s`)
  expect(toasts.at(-1)).toContain('устарели')
  expect(d.store.keys('limit_notify:')).toHaveLength(0)
})

test('overlapping page clicks serialize against the latest persisted view',async()=>{
  const {d,ctx,edits}=setup();await usageScreen(d,{chatId:'111'});const v=viewOf(d)
  let release!:()=>void,started!:()=>void
  const began=new Promise<void>(resolve=>{started=resolve})
  const original=ctx.editMessageText.bind(ctx)
  Object.assign(ctx,{editMessageText:async(text:string,extra:any)=>{await original(text,extra);if(edits.length===1){started();await new Promise<void>(resolve=>{release=resolve})}}})
  const first=handleResetCallback(d,ctx,`uv:${v.id}:g:1`);await began
  const last=handleResetCallback(d,ctx,`uv:${v.id}:g:${v.pages.length-1}`)
  release();await first;await last
  expect(edits).toHaveLength(2)
  expect(loadUsageView(d,v.id)?.page).toBe(v.pages.length-1)
})
