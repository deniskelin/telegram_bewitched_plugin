import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { reduceSession, applySessionEvent, isLateHook, type SessionState, type SessionEvent } from '../src/core/session.ts'
import { Tasks, ownsTask, taskBatchMeta, type Task, type TaskRepository } from '../src/core/task.ts'

const idle = (): SessionState => ({ status: 'idle', turn: null, stoppedAt: null, lastActivity: 0 })
describe('pure lifecycle core', () => {
  test('transitions do not mutate their input and a hook cannot revive a stopped turn', () => {
    const initial = idle()
    const started = reduceSession(initial, {type:'delivered',at:10})
    expect(initial).toEqual(idle()); expect(started.openedTurn).toBe(true)
    const stopped = reduceSession(started.state,{type:'stop_requested',at:20}).state
    expect(stopped.status).toBe('working') // Escape is not proof of completion.
    const original = structuredClone(stopped)
    expect(reduceSession(stopped,{type:'activity',at:21}).accepted).toBe(false)
    expect(reduceSession(stopped,{type:'permission_requested'}).accepted).toBe(false)
    expect(reduceSession(stopped,{type:'permission_resolved'}).accepted).toBe(false)
    expect(stopped).toEqual(original)
    const restarted = reduceSession(stopped,{type:'prompt',at:30})
    expect(restarted.openedTurn).toBe(true); expect(restarted.state.turn?.start).toBe(30)
    expect(restarted.state.stopRequest).toBeUndefined()
    expect(isLateHook(restarted.state,{event:'Stop',at:19},31)).toBe(true)
    expect(isLateHook(restarted.state,{event:'MessageDisplay',at:19},31)).toBe(true)
    expect(isLateHook(restarted.state,{event:'PreToolUse',at:31},31)).toBe(false)
  })
  test('a reused wall-clock timestamp cannot let an old stop acknowledgement stop a new turn', () => {
    const s = idle(); applySessionEvent(s,{type:'delivered',at:10})
    applySessionEvent(s,{type:'stop_requested',at:20}); const first = s.stopRequest!.token
    applySessionEvent(s,{type:'prompt',at:21}); applySessionEvent(s,{type:'stop_requested',at:20})
    const second = s.stopRequest!.token
    expect(second).not.toBe(first)
    for (const success of [false,true]) expect(applySessionEvent(s,{type:'stop_checked',at:20,token:first,idle:success,checkedAt:22}).accepted).toBe(false)
    expect(s.status).toBe('working'); expect(s.stopRequest?.phase).toBe('sent')
    expect(applySessionEvent(s,{type:'stop_checked',at:20,token:second,idle:true,checkedAt:23}).accepted).toBe(true)
    expect(s.status).toBe('idle'); expect(s.turn).toBeNull(); expect(s.turnEndedAt).toBe(23)
  })
  test('all stop completion orderings preserve a newer prompt', () => {
    const permutations = <T>(items:T[]):T[][] => items.length ? items.flatMap((x,i) => permutations(items.filter((_,j)=>i!==j)).map(xs=>[x,...xs])) : [[]]
    for (const events of permutations<SessionEvent>([
      {type:'stop_checked',at:2,token:1,idle:false,checkedAt:4},
      {type:'stop_checked',at:2,token:1,idle:true,checkedAt:4},
      {type:'prompt',at:3},
    ])) {
      const s = idle(); applySessionEvent(s,{type:'delivered',at:1}); applySessionEvent(s,{type:'stop_requested',at:2})
      for (const event of events) applySessionEvent(s,event)
      expect(s.status).toBe('working'); expect(s.turn?.start).toBe(3); expect(s.stopRequest).toBeUndefined()
    }
  })
  test('restored state preserves stop tokens; context-only delivery opens no artificial turn', () => {
    const s = idle(); applySessionEvent(s,{type:'delivered',at:1,startTurn:false})
    expect(s.status).toBe('idle'); expect(s.turn).toBeNull()
    applySessionEvent(s,{type:'activity',at:2}); expect(s.turn?.byHook).toBe(true)
    applySessionEvent(s,{type:'stop_requested',at:3})
    const restored:SessionState = JSON.parse(JSON.stringify(s))
    expect(applySessionEvent(restored,{type:'stop_checked',at:3,token:s.stopRequest?.token,idle:true,checkedAt:4}).accepted).toBe(true)
    expect(restored.status).toBe('idle')
  })
  test('task lifecycle uses a repository port and cannot reopen a closed task on a late result', () => {
    const rows = new Map<string,Task>(), current = new Map<string,string>()
    const key = (c:{chatId:string;threadId?:number},u:string) => `${c.chatId}:${c.threadId ?? 0}:${u}`
    const port:TaskRepository = {
      get:id => rows.get(id) ?? null, commit:(t,id) => {rows.set(t.id,t); if(id) current.set(key(t.chat,t.user),id);else current.delete(key(t.chat,t.user))},
      current:(c,u) => current.get(key(c,u)) ?? null,
    }
    let n = 0, at = 10
    const chat = {chatId:'111',isPrivate:true}
    const service = new Tasks(port,()=>String(++n),()=>at++)
    const first = service.create(chat,'111'); service.change(first.id,'closed')
    const second = service.create(chat,'111')
    const restored = new Tasks(port,()=>String(++n),()=>at++)
    restored.change(first.id,'ready')
    expect(port.get(first.id)?.state).toBe('closed'); expect(port.current(chat,'111')).toBe(second.id)
    restored.change(first.id,'open'); expect(port.current(chat,'111')).toBe(first.id)
    expect(ownsTask(first,{...chat,threadId:37},'111')).toBe(false)
    expect(ownsTask(first,chat,'222')).toBe(false)
    expect(ownsTask(first,chat,'111')).toBe(true)
  })
  test('batching preserves all task identities even when the last message has no explicit intent', () => {
    expect(taskBatchMeta([{task_id:'a',task_kind:'fix'},{task_id:'a'}])).toEqual({task_id:'a',task_kind:'fix'})
    expect(taskBatchMeta([{task_ids:'a,b',task_kind:'fix'},{task_id:'c',task_kind:'review'}])).toEqual({task_id:'',task_ids:'a,b,c',task_kind:'',task_kinds:'fix,review'})
  })
  test('the core cannot import runtime infrastructure or acquire its own clock', () => {
    const dir = join(import.meta.dir,'../src/core')
    for (const file of readdirSync(dir).filter(f=>f.endsWith('.ts'))) {
      const source = readFileSync(join(dir,file),'utf8')
      expect(source).not.toMatch(/\b(?:Date\.now|Bun\.|process\.|setTimeout|setInterval)\b/)
      for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) expect(match[1]).toMatch(/^\.\//)
    }
  })
})


test('the lifecycle projection never copies process/socket handles into domain state', () => {
  const session = {...idle(), sock:{secret:'adapter-owned'}, cwd:'/project'}
  const result = reduceSession(session,{type:'delivered',at:1})
  expect(result.state).not.toHaveProperty('sock')
  expect(result.state).not.toHaveProperty('cwd')
  const stopped = {...session,stoppedAt:1}
  expect(reduceSession(stopped,{type:'activity',at:2}).state).not.toHaveProperty('sock')
  applySessionEvent(session,{type:'delivered',at:1})
  expect(session.sock).toEqual({secret:'adapter-owned'})
})

test('daemon adapters cannot independently assign lifecycle state', () => {
  const dir = join(import.meta.dir,'../src/daemon')
  for (const file of readdirSync(dir).filter(f=>f.endsWith('.ts'))) {
    const source = readFileSync(join(dir,file),'utf8')
    expect(source).not.toMatch(/\b(?:s|session)\.(?:status|turn|stoppedAt|stopRequest)\s*=(?!=)/)
    expect(source).not.toMatch(/\b(?:s|session)\.turn\.(?:stuck|replied)\s*=(?!=)/)
  }
})
