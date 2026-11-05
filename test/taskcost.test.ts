import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { Store } from '../src/db.ts'
import type { Daemon, Session } from '../src/daemon/daemon.ts'
import { bindTask, newTask, taskOf, changeTask, startStage, activeStage, stageHook, finishStage, reconcile, taskReport, taskUsageData, startAuxiliary, finishAuxiliary } from '../src/daemon/taskcost.ts'
import { parseRollout } from '../src/daemon/codexusage.ts'
import { taskBatchMeta } from '../src/daemon/economy.ts'
const chat = { chatId: '111', isPrivate: true }
function setup() {
  const path = join(mkdtempSync(join(tmpdir(), 'task-cost-')), 'conversation.jsonl')
  writeFileSync(path, '')
  const d = { store: new Store(':memory:'), log: () => {}, bot: { api: {} } } as unknown as Daemon
  const s = { id: 'one', engine: 'claude', projectKey: '/p', cwd: '/p', claude: { sessionId: 'conv', transcript: path } } as Session
  const meta: Record<string,string> = {}; const id = bindTask(d, chat, '111', meta)
  const prompt = (task: string) => appendFileSync(path, JSON.stringify({ type: 'user', message: { content: `<channel task_id="${task}">request</channel>` } })+'\n')
  const usage = (message: string, output = 20) => appendFileSync(path, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), requestId: message, message: { id: message, model: 'claude-sonnet-4-5', usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: output } } })+'\n')
  return { d,s,path,meta,id,prompt,usage }
}
describe('task identity and exact conversation accounting', () => {
  test('scope, lifecycle, explicit new tasks, continuation and durable identity', () => {
    const {d,id} = setup()
    const same: Record<string,string> = {}; expect(bindTask(d,chat,'111',same)).toBe(id)
    changeTask(d,id,'ready'); expect(bindTask(d,chat,'111',{})).toBe(id)
    expect(bindTask(d,{...chat,threadId:1},'111',{})).not.toBe(id)
    expect(bindTask(d,chat,'222',{})).not.toBe(id)
    changeTask(d,id,'closed'); const next = bindTask(d,chat,'111',{}); expect(next).not.toBe(id)
    changeTask(d,id,'open'); expect(bindTask(d,chat,'111',{})).toBe(id)
    const fresh = bindTask(d,chat,'111',{},true); expect(fresh).not.toBe(id)
    // An explicit reply restores its own task, not the latest task in a project.
    d.store.set('ux:result:r',JSON.stringify({ taskId:id, chat, messages:[12], card:13 }))
    expect(bindTask(d,chat,'111',{reply_to_message_id:'13'})).toBe(id)
    expect(taskOf(d,id)?.state).toBe('open')
    const forged = { task_id:id }; expect(bindTask(d,chat,'222',forged)).not.toBe(id)
    expect(taskOf(d,next)?.id).toBe(next)
  })
  test('counts updated usage once; transcript baseline excludes previous and neighboring work', () => {
    const {d,s,id,meta,prompt,usage} = setup()
    prompt('0000000000000000'); usage('old')
    startStage(d,s,meta); prompt(id); usage('current',10); usage('current',30)
    stageHook(d,s,'tool-1'); stageHook(d,s,'tool-1'); finishStage(d,s)
    const r = activeStage(d,s)!; reconcile(d,r)
    expect(r.entries).toHaveLength(1); expect(r.entries[0]!.output).toBe(30); expect(r.tools).toHaveLength(1)
    prompt('1111111111111111'); usage('neighbor')
    reconcile(d,r); expect(r.entries).toHaveLength(1)
    expect(taskReport(d,id)).toContain('300 / 200 / 30')
  })
  test('late final tokens refresh the same stage and survive daemon/session restart', () => {
    const {d,s,id,meta,prompt,usage} = setup()
    startStage(d,s,meta); prompt(id); finishStage(d,s)
    expect(activeStage(d,s)?.settled).toBe(false)
    usage('late',40); const r = activeStage(d,s)!; reconcile(d,r)
    expect(r.settled).toBe(true); expect(r.entries[0]?.output).toBe(40)
    d.store.set('cost:active:one',null)
    stageHook(d,{...s,id:'reconnected'})
    // Ended stages are retained for the total even if there is no active stage.
    expect(taskReport(d,id)).toContain('300 / 200 / 40')
  })
  test('shared batched tasks are not silently charged twice', () => {
    const {d,s,id,meta,prompt,usage} = setup()
    const other = newTask(d,chat,'111').id
    const batch = taskBatchMeta([meta,{task_id:other}])
    expect(batch.task_ids).toContain(id); expect(batch.task_ids).toContain(other)
    startStage(d,s,batch); prompt(id); usage('shared'); finishStage(d,s)
    expect(taskReport(d,id)).toContain('расход не распределён')
    expect(taskReport(d,other)).toContain('расход не распределён')
  })
  test('independent review attempts contribute to the same task without a session cwd scan', () => {
    const {d,id} = setup()
    const stage = startAuxiliary(d,id,'codex')!
    const out = JSON.stringify({type:'turn.completed',usage:{input_tokens:500,cached_input_tokens:200,output_tokens:50,reasoning_output_tokens:20}})
    finishAuxiliary(d,stage,out,'gpt-test'); finishAuxiliary(d,stage,out,'gpt-test')
    expect(taskReport(d,id)).toContain('500 / 200 / 50')
    expect(taskReport(d,id)).toContain('gpt-test (review)')
    expect(taskReport(d,id)).toContain('20')
    const retry = startAuxiliary(d,id,'claude')!
    finishAuxiliary(d,retry,JSON.stringify({type:'result', modelUsage:{'claude-sonnet-4-5':{inputTokens:10,outputTokens:5,cacheReadInputTokens:0}}}))
    expect(taskReport(d,id)).toContain('510 / 200 / 55')
  })
  test('Codex cumulative counters use deltas and reasoning stays a subset of output', () => {
    const text = [{type:'event_msg',payload:{type:'user_message',message:'<channel task_id="1234567890abcdef">x</channel>'}}, ...[100,100,150].map(n => ({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,cached_input_tokens:n/2,output_tokens:n/10,reasoning_output_tokens:n/50}}}}))].map(e=>JSON.stringify(e)).join('\n')
    const entries = parseRollout(text,'exact-conversation',0).entries
    expect(entries).toHaveLength(2)
    expect(entries.reduce((n,e)=>n+e.input+e.read,0)).toBe(150)
    expect(entries.reduce((n,e)=>n+(e.reasoning??0),0)).toBe(3)
    expect(entries[1]?.tasks).toEqual(['1234567890abcdef'])
  })
})

test('consecutive stages, including same-millisecond dispatch, do not count each other', () => {
  const {d,s,id,meta,prompt,usage} = setup()
  startStage(d,s,meta); prompt(id); usage('first',30); finishStage(d,s)
  const first = activeStage(d,s)!
  startStage(d,s,meta); prompt(id); usage('second',50); finishStage(d,s)
  reconcile(d,first)
  expect(first.entries.map(e=>e.output)).toEqual([30])
  expect(taskReport(d,id)).toContain('600 / 400 / 80')
  expect(taskReport(d,id)).toContain('2 / 0 /')
})

test('an open stage reconnects by conversation ID and retains tool IDs', () => {
  const {d,s,id,meta,prompt,usage} = setup()
  startStage(d,s,meta); prompt(id); stageHook(d,s,'before-restart')
  d.store.set('cost:active:one',null)
  const next = {...s,id:'after-restart'}
  stageHook(d,next,'after-restart')
  expect(activeStage(d,next)?.tasks).toEqual([id])
  expect(activeStage(d,next)?.tools).toEqual(['before-restart','after-restart'])
  usage('continued'); finishStage(d,next)
  expect(taskReport(d,id)).toContain('300 / 200 / 20')
})

test('result lifecycle and replay controls never launch a model or add a stage', async () => {
  const {d,s,id,meta,prompt,usage} = setup()
  const calls: string[] = []
  Object.assign(d.bot, { api: new Proxy({}, {get: (_,method:string) => async () => { calls.push(method); return {message_id:900} }}) })
  const { publishResult, lastResult, handleUxCallback } = await import('../src/daemon/ux.ts')
  const previous = process.env.RESULT_CARDS; process.env.RESULT_CARDS = 'on'
  try {
    startStage(d,s,meta); prompt(id); usage('result'); finishStage(d,s)
    await publishResult(d,s,chat,[21],'answer',{summary:'done',checks:'verified'})
    const result = lastResult(d,s.projectKey)!
    expect(result.taskId).toBe(id); expect(result.cost).toContain('300 / 200 / 20')
    expect(taskOf(d,id)?.state).toBe('ready')
    const ctx = {from:{id:111}, callbackQuery:{message:{chat:{id:111}}}, answerCallbackQuery:async()=>{}} as never
    const before = d.store.keys('cost:stage:').length
    await handleUxCallback(d,ctx,`urx:repeat:${result.id}`)
    await handleUxCallback(d,ctx,`urx:cost:${result.id}`)
    expect(calls).toContain('sendDocument')
    expect(taskUsageData(d,id).totals).toMatchObject({input:300,cached:200,output:20,requests:1})
    expect(calls).toContain('copyMessage'); expect(d.store.keys('cost:stage:')).toHaveLength(before)
    await handleUxCallback(d,ctx,`urx:close:${result.id}`); expect(taskOf(d,id)?.state).toBe('closed')
    const unrelated = bindTask(d,chat,'111',{},true)
    changeTask(d,id,'ready')
    // A delayed result must not change the current task to an older one.
    expect(bindTask(d,chat,'111',{})).toBe(unrelated)
    await handleUxCallback(d,ctx,`urx:continue:${result.id}`)
    expect(bindTask(d,chat,'111',{})).toBe(id)
    expect(d.store.keys('cost:stage:')).toHaveLength(before)
  } finally { process.env.RESULT_CARDS = previous }
})


test('native agents keep their parent task even when finishing during a neighboring task', () => {
  const {d,s,path,id,meta,prompt,usage} = setup()
  startStage(d,s,meta); prompt(id); usage('root-a')
  appendFileSync(path, JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'spawn-a',name:'Agent'}]}})+'\n')
  finishStage(d,s); const first = activeStage(d,s)!
  const second = newTask(d,chat,'111').id
  startStage(d,s,{task_id:second}); prompt(second); usage('root-b')
  const dir = join(dirname(path),'conversation','subagents'); mkdirSync(dir,{recursive:true})
  const sub = {type:'assistant',timestamp:new Date().toISOString(),message:{id:'native-a',model:'claude-sonnet-4-5',usage:{input_tokens:10,output_tokens:7}}}
  writeFileSync(join(dir,'agent-agent-a.jsonl'),JSON.stringify(sub)+'\n')
  appendFileSync(path,JSON.stringify({type:'user',toolUseResult:{agentId:'agent-a'},message:{content:[{type:'tool_result',tool_use_id:'spawn-a',content:'done'}]}})+'\n')
  finishStage(d,s); reconcile(d,first)
  expect(taskReport(d,id)).toContain('310 / 200 / 27')
  expect(taskReport(d,second)).toContain('300 / 200 / 20')
  writeFileSync(join(dir,'agent-unknown.jsonl'),JSON.stringify({...sub,message:{...sub.message,id:'unknown'}})+'\n')
  reconcile(d,first)
  expect(first.unallocatedRequests).toBe(1)
  expect(taskReport(d,id)).toContain('без подтверждённой связи')
})
