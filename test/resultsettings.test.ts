import { test, expect } from 'bun:test'
import { Store } from '../src/db.ts'
import { loadAccess, saveAccess } from '../src/access.ts'
import { settings } from '../src/config.ts'
import type { Daemon, Session } from '../src/daemon/daemon.ts'
import type { Context } from 'grammy'
import { handleResultSettings, resultSettingsTarget, resultReportsOn } from '../src/daemon/resultsettings.ts'

function ctx(actor:number,chat=actor,thread?:number){return {from:{id:actor},chat:{id:chat},callbackQuery:{message:{message_id:1,chat:{id:chat},message_thread_id:thread}},answerCallbackQuery:async()=>{},editMessageText:async()=>{}} as unknown as Context}
test('members control only their own session, owners can configure project topics; preferences survive reconnects',async()=>{
  const before=loadAccess();saveAccess({...before,allowFrom:[...before.allowFrom,'222']})
  try{
    const own={id:'aabbccdd',projectKey:settings.usersDir+'/222'} as Session
    const project={id:'11223344',projectKey:'/project'} as Session
    const other={id:'55667788',projectKey:settings.usersDir+'/333'} as Session
    const d={store:new Store(':memory:'),isTopicsChat:(chat:string)=>chat==='-100',userSession:(user:string)=>user==='222'?own:null,userIdOf:(s:Session)=>s===own?'222':s===other?'333':null,sessionForThread:(_:string,t:number)=>t===37?project:t===38?other:null,log:()=>{}} as unknown as Daemon
    expect(resultReportsOn(d,own.projectKey)).toBe(false)
    await handleResultSettings(d,ctx(222),'rs:on')
    expect(resultReportsOn(d,own.projectKey)).toBe(true)
    expect(resultReportsOn(d,project.projectKey)).toBe(false)
    expect(resultReportsOn({...d} as Daemon,own.projectKey)).toBe(true)
    await handleResultSettings(d,ctx(222,-100,37),'rs:on')
    await handleResultSettings(d,ctx(222,-100,38),'rs:on')
    await handleResultSettings(d,ctx(222,333),'rs:on')
    expect(resultReportsOn(d,project.projectKey)).toBe(false)
    expect(resultReportsOn(d,other.projectKey)).toBe(false)
    await handleResultSettings(d,ctx(111,-100,37),'rs:on')
    expect(resultReportsOn(d,project.projectKey)).toBe(true)
    await handleResultSettings(d,ctx(222),'rs:off')
    expect(resultReportsOn(d,own.projectKey)).toBe(false)
    expect(resultReportsOn(d,project.projectKey)).toBe(true)
    expect(resultSettingsTarget(d,ctx(999))).toBeNull()
    expect(resultSettingsTarget({...d,userSession:()=>null} as unknown as Daemon,ctx(222))).toBe(own.projectKey)
  }finally{saveAccess(before)}
})
