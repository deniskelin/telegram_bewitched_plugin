/**
 * Which language a chat gets: its own choice (/lang, /menu → ⚙️), else in a
 * DM the user's Telegram language (remembered from their messages), else the
 * default — the owner's choice in their DM, else BOT_LANGUAGE, else Russian.
 */

import type { Bot, Context } from 'grammy'
import { loadAccess, owner } from '../access.ts'
import { normLang, setDefaultLang, withLang, type Lang } from '../i18n/index.ts'
import type { Daemon, Session } from './daemon.ts'
import { sessionTarget } from './topics.ts'

/** The chat's own setting only (a topic inherits its group's). */
function chosen(chatId: string, threadId?: number): Lang | null {
  const chats = loadAccess().prefs?.chats ?? {}
  return normLang((threadId != null ? chats[`${chatId}:${threadId}`]?.lang : undefined) ?? chats[chatId]?.lang)
}

export function defaultLang(d: Daemon): Lang {
  const o = owner()
  return (o ? chosen(o) ?? normLang(d.store.get(`tg_lang:${o}`)) : null) ?? normLang(process.env.BOT_LANGUAGE) ?? 'ru'
}

export function langFor(d: Daemon, chatId: string, threadId?: number): Lang {
  return chosen(chatId, threadId) ?? (!chatId.startsWith('-') ? normLang(d.store.get(`tg_lang:${chatId}`)) : null) ?? defaultLang(d)
}

/** Run f in the language of the chat it writes to. */
export function inChat<T>(d: Daemon, chatId: string, threadId: number | undefined, f: () => T): T {
  return withLang(langFor(d, chatId, threadId), f)
}

/** Run f in the language of the chat a session talks to (its tool calls, its notices). */
export function inSession<T>(d: Daemon, s: Session, f: () => T): T {
  const c = sessionTarget(d, s)
  return c ? inChat(d, c.chatId, c.threadId, f) : f()
}

/** First middleware: remember the sender's Telegram language, run the update in the chat's language. */
export function installLang(d: Daemon, bot: Bot): void {
  setDefaultLang(() => defaultLang(d))
  bot.use((ctx: Context, next) => {
    const from = ctx.from
    const code = normLang(from?.language_code)
    if (from && code && d.store.get(`tg_lang:${from.id}`) !== code) d.store.set(`tg_lang:${from.id}`, code)
    const msg = ctx.callbackQuery?.message ?? ctx.message
    const thread = msg && 'is_topic_message' in msg && msg.is_topic_message ? msg.message_thread_id : undefined
    const chat = ctx.chat ? String(ctx.chat.id) : from ? String(from.id) : null
    return chat ? withLang(langFor(d, chat, thread), next) : next()
  })
}
