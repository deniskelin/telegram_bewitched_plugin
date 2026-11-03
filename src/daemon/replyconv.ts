/**
 * FR-20: a reply to an old bot message goes back to that message's
 * conversation. The daemon knows which conversation a folder had when
 * (engines.ts conversationHistory); a reply to a bot message written in an
 * earlier conversation than the session's current one is held, and the user
 * picks: «↩️ Продолжить тот разговор» (Claude: /resume <id> in the same
 * session; Codex: a restart with that thread) or «➡️ В текущий».
 */

import { InlineKeyboard, type Context } from 'grammy'
import { randomBytes } from 'crypto'
import { can } from '../access.ts'
import { locale, t } from '../i18n/index.ts'
import type { ChatRef, Daemon, Session } from './daemon.ts'
import { conversationAt, engineOf, type ConvMark } from './engines.ts'
import { controlAction, show, switchSession } from './menu.ts'
import { button } from './stream.ts'

type Held = { sessionId: string; conv: ConvMark; text: string; meta: Record<string, string>; chat: ChatRef; at: number }

const held = new Map<string, Held>()
const TTL_MS = 30 * 60_000

/** The conversation of the bot message a reply points at, when it is not the session's current one. */
export function oldConversationOf(d: Daemon, s: Session, chat: ChatRef, meta: Record<string, string>): ConvMark | null {
  if (meta.reply_to_from !== 'bot' || !meta.reply_to_message_id) return null
  const m = d.store.getMessage(chat.chatId, Number(meta.reply_to_message_id))
  if (!m || m.direction !== 'out') return null
  const conv = conversationAt(d, s.cwd, m.date * 1000)
  const current = s.claude.sessionId
  if (!conv || !current || conv.id === current) return null
  return conv
}

/**
 * Deliver a message, unless it replies to a message of an older conversation:
 * then ask where it goes. Returns true when the message was held.
 */
export async function holdIfOldConversation(d: Daemon, s: Session, chat: ChatRef, text: string, meta: Record<string, string>): Promise<boolean> {
  const conv = oldConversationOf(d, s, chat, meta)
  if (!conv) return false
  for (const [k, h] of held) if (Date.now() - h.at > TTL_MS) held.delete(k)
  const id = randomBytes(4).toString('hex')
  held.set(id, { sessionId: s.id, conv, text, meta, chat, at: Date.now() })
  const day = new Date(conv.at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  const other = conv.engine !== s.engine
  const kb = new InlineKeyboard([[
    ...(other ? [] : [button(t('↩️ Продолжить тот разговор'), `rc:old:${id}`, 'primary')]),
    button(t('➡️ В текущий'), `rc:cur:${id}`, other ? 'primary' : undefined),
  ]])
  const body = other
    ? t('↩️ Это ответ на сообщение из прошлого разговора ({engine}, с {when}). Вернуться к нему можно после переключения движка в 🧠; сейчас — отправить в текущий?', { engine: engineOf(conv.engine).name, when: day })
    : t('↩️ Это ответ на сообщение из прошлого разговора (с {when}). Продолжить тот разговор или отправить в текущий?', { when: day })
  await d.bot.api.sendMessage(chat.chatId, body, {
    reply_markup: kb,
    ...(chat.threadId != null ? { message_thread_id: chat.threadId } : {}),
    ...(meta.message_id ? { reply_parameters: { message_id: Number(meta.message_id), allow_sending_without_reply: true } } : {}),
  })
  d.log(`reply to an old conversation (${conv.engine} ${conv.id}) held for session ${s.id}`)
  return true
}

/** rc:old|cur:<id> */
export async function handleReplyConvCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^rc:(old|cur):([0-9a-f]+)$/.exec(data)
  if (!m) return false
  if (!ctx.from || !can(ctx.from.id, 'write')) {
    await ctx.answerCallbackQuery({ text: t('Нет доступа.') }).catch(() => {})
    return true
  }
  const h = held.get(m[2])
  const s = h ? d.sessions.get(h.sessionId) : undefined
  if (!h || !s) {
    await ctx.answerCallbackQuery({ text: t('Уже неактуально.') }).catch(() => {})
    return true
  }
  held.delete(m[2])
  const done = (label: string) => ctx.editMessageText(label).catch(() => {})
  if (m[1] === 'cur') {
    await ctx.answerCallbackQuery({ text: t('➡️ В текущий разговор') }).catch(() => {})
    await done(t('➡️ Отправлено в текущий разговор.'))
    d.deliver(s, h.text, h.meta, h.chat)
    return true
  }
  await ctx.answerCallbackQuery({ text: t('↩️ Возвращаюсь к тому разговору') }).catch(() => {})
  // Claude: /resume <id> in the same session, no restart. Codex or another engine: a restart with that conversation.
  if (h.conv.engine === 'claude' && s.engine === 'claude') {
    const r = await controlAction(d, s, 'resume', h.conv.id)
    if (!r.sent) {
      await done(t('⛔ Не получилось вернуться к тому разговору: {why}. Сообщение ушло в текущий.', { why: r.toast ?? '?' }))
      d.deliver(s, h.text, h.meta, h.chat)
      return true
    }
    s.claude.sessionId = h.conv.id
    await done(t('↩️ Продолжаю тот разговор.'))
    // Give /resume a moment to load the conversation before the message lands.
    setTimeout(() => d.deliver(s, h.text, h.meta, h.chat), 3000).unref?.()
    return true
  }
  if (h.conv.engine !== s.engine) {
    await done(t('⛔ Тот разговор был на {engine}: переключите движок проекта в 🧠 и повторите. Сообщение ушло в текущий.', { engine: engineOf(h.conv.engine).name }))
    d.deliver(s, h.text, h.meta, h.chat)
    return true
  }
  void switchSession(d, s, sc => show(ctx, sc).catch(() => {}), {
    resume: h.conv.id,
    after: async n => d.deliver(n, h.text, h.meta, h.chat),
  }).catch(err => d.log(`reply resume of ${s.id} failed: ${err}`))
  return true
}
