/** Opt-in automatic result cards, persisted per logical session across reconnects. */
import { join } from 'path'
import { InlineKeyboard, type Context } from 'grammy'
import { can } from '../access.ts'
import { settings } from '../config.ts'
import { t } from '../i18n/index.ts'
import type { Daemon } from './daemon.ts'
import { resolveTarget } from './inbound.ts'
import { button } from './stream.ts'
import { viewScope } from './usageview.ts'
import type { Screen } from './menu.ts'
const key=(project:string)=>`ux:result-reports:${project}`
export const resultReportsOn=(d:Daemon,project:string):boolean=>d.store.get(key(project))==='on'
export function setResultReports(d:Daemon,project:string,on:boolean):void{d.store.set(key(project),on?'on':'off')}
/** Members manage only their own user session; shared projects require the owner. */
export function resultSettingsTarget(d:Daemon,ctx:Context):string|null{
  if(!ctx.from||!can(ctx.from.id,'write'))return null
  const actor=String(ctx.from.id),c=viewScope(ctx),isPrivate=!c.chatId.startsWith('-')
  if(isPrivate&&c.chatId!==actor)return null
  const target=resolveTarget(d,{...c,isPrivate},actor)
  if(target.kind==='user_offline')return join(settings.usersDir,actor)
  if(target.kind==='session')return can(actor,'control')||d.userIdOf(target.session)===actor?target.session.projectKey:null
  if(can(actor,'control')&&'projectKey'in target&&target.projectKey)return target.projectKey
  return null
}
export function resultSettingsScreen(d:Daemon,project:string):Screen{
  const on=resultReportsOn(d,project)
  return{text:[t('⚙️ <b>Настройки сессии</b>'),t('Отдельный итоговый отчёт: {state}',{state:on?t('включён'):t('выкл')}),t('Обычные ответы приходят всегда. Настройка итогов сохраняется для этой сессии.')].join('\n\n'),kb:new InlineKeyboard([[button(`${on?'• ':''}${t('📋 Итоги: включить')}`,'rs:on',on?'primary':undefined),button(`${!on?'• ':''}${t('📋 Итоги: выключить')}`,'rs:off',!on?'primary':undefined)]])}
}
export async function handleResultSettings(d:Daemon,ctx:Context,data:string):Promise<boolean>{
  const match=/^rs:(open|on|off)$/.exec(data);if(!match)return false
  const project=resultSettingsTarget(d,ctx)
  if(!project){await ctx.answerCallbackQuery({text:t('Нет доступа.')}).catch(()=>{});return true}
  if(match[1]!=='open')setResultReports(d,project,match[1]==='on')
  const screen=resultSettingsScreen(d,project)
  await ctx.answerCallbackQuery(match[1]==='open'?undefined:{text:t('Сохранено')}).catch(()=>{})
  await ctx.editMessageText(screen.text,{parse_mode:'HTML',reply_markup:screen.kb}).catch(err=>d.log(`result settings: ${err}`))
  return true
}
