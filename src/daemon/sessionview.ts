/** Saved list preferences and position, scoped to the actor and menu message. */
import type { Context } from 'grammy'
import type { Daemon } from './daemon.ts'
import { viewScope } from './usageview.ts'
export type SessionFilter='all'|'attention'|'working'|'projects'|'users'|'passive'
export type SessionView={filter:SessionFilter;page:number}
export const SESSION_FILTERS:SessionFilter[]=['all','attention','working','projects','users','passive']
function keys(ctx:Context){const c=viewScope(ctx),actor=ctx.from?.id??0,message=ctx.callbackQuery?.message?.message_id??ctx.message?.message_id??0;return{view:`session:list:${c.chatId}:${c.threadId??0}:${actor}:${message}`,favorite:`session:filter:${c.chatId}:${c.threadId??0}:${actor}`}}
export function sessionView(d:Daemon,ctx:Context):SessionView{const k=keys(ctx);const saved=JSON.parse(d.store.get(k.view)??'null');const filter=saved?.filter??d.store.get(k.favorite)??'all';return{filter:SESSION_FILTERS.includes(filter)?filter:'all',page:Number.isSafeInteger(saved?.page)&&saved.page>=0?saved.page:0}}
export function saveSessionView(d:Daemon,ctx:Context,v:SessionView):void{const k=keys(ctx);d.store.set(k.view,JSON.stringify(v));d.store.set(k.favorite,v.filter)}
