/**
 * ⚡ Quick commands: buttons with a saved text for a chat (a topic, a DM).
 * A tap sends the text to the chat's session as if it was written there, and
 * posts it to the chat so everyone sees what was asked.
 *
 *   /macro                         — the list with buttons
 *   /macro add <label> | <text>    — add (label up to 30 chars)
 *   /macro del <n>                 — remove
 *
 * Callback data: mc:l:<chat>:<thread|0>, mc:r:<chat>:<thread|0>:<n>,
 * mc:list:<session id> (from the session card).
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { can } from '../access.ts'
import { clip, escapeHtml } from '../format.ts'
import type { ChatRef, Daemon } from './daemon.ts'
import { show, type Screen } from './menu.ts'
import { sessionChat } from './report.ts'
import { button } from './stream.ts'
import { t } from '../i18n/index.ts'

export type Macro = { label: string; text: string }
type Where = { chatId: string; threadId?: number }

const MAX = 12
const USAGE = t('Формат: /macro add <кнопка> | <текст для сессии>\nНапример: /macro add 🧪 Тесты | прогони тесты и пришли итог')

const keyOf = (w: Where) => `macros:${w.threadId != null ? `${w.chatId}:${w.threadId}` : w.chatId}`
const ref = (w: Where) => `${w.chatId}:${w.threadId ?? 0}`

export function listMacros(d: Daemon, w: Where): Macro[] {
  try {
    const v = JSON.parse(d.store.get(keyOf(w)) ?? '[]')
    return Array.isArray(v) ? v.filter((m): m is Macro => typeof m?.label === 'string' && typeof m?.text === 'string') : []
  } catch {
    return []
  }
}

function save(d: Daemon, w: Where, list: Macro[]): void {
  d.store.set(keyOf(w), list.length ? JSON.stringify(list) : null)
}

/** "<label> | <text>" → a macro, or null. */
export function parseMacro(arg: string): Macro | null {
  const i = arg.indexOf('|')
  if (i < 0) return null
  const label = arg.slice(0, i).trim().slice(0, 30)
  const text = arg.slice(i + 1).trim()
  return label && text ? { label, text } : null
}

export function macrosScreen(d: Daemon, w: Where, back?: string): Screen {
  const list = listMacros(d, w)
  const lines = [t('⚡ <b>Быстрые команды</b> этого чата'), list.length ? t('Кнопка отправляет текст сессии чата, как будто вы его написали.') : t('Пока нет ни одной.')]
  for (const [i, m] of list.entries()) lines.push(`${i + 1}. <b>${escapeHtml(m.label)}</b> — ${escapeHtml(clip(m.text, 80))}`)
  lines.push('', t('Добавить (в этом чате): <code>/macro add 🧪 Тесты | прогони тесты</code>{v}', { v: list.length ? t('\nУдалить: <code>/macro del 1</code>') : '' }))
  const rows = []
  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map((m, j) => button(clip(`⚡ ${m.label}`, 40), `mc:r:${ref(w)}:${i + j}`)))
  rows.push([button(t('« Назад'), back ?? 'hub:main')])
  return { text: lines.join('\n'), kb: new InlineKeyboard(rows) }
}

/** Post the text in the chat and hand it to the chat's session (launched or queued if needed). */
export async function runMacro(d: Daemon, w: Where, m: Macro, fromId: string): Promise<void> {
  const thread = w.threadId != null ? { message_thread_id: w.threadId } : {}
  await d.bot.api.sendMessage(w.chatId, `⚡ ${m.text}`, thread).catch(err => d.log(`macro post failed: ${err}`))
  const isPrivate = !w.chatId.startsWith('-')
  const chat: ChatRef = { chatId: w.chatId, threadId: w.threadId, isPrivate }
  // In a DM the session is the DM's owner's, whoever pressed the button.
  const from = isPrivate ? w.chatId : fromId
  const meta: Record<string, string> = {
    chat_id: w.chatId, ...(w.threadId != null ? { thread_id: String(w.threadId) } : {}),
    user_id: from, user: d.userLabel(fromId), ts: new Date().toISOString(), event: 'macro', macro: m.label,
  }
  await d.routeText(chat, from, m.text, meta)
}

function whereOf(ctx: Context): Where {
  const msg = ctx.message
  return { chatId: String(ctx.chat!.id), threadId: msg?.is_topic_message ? msg.message_thread_id : undefined }
}

export function registerMacroCommands(d: Daemon, bot: Bot): void {
  bot.command('macro', async ctx => {
    if (!ctx.from || !can(ctx.from.id, 'control') || !ctx.chat) return
    const w = whereOf(ctx)
    const thread = w.threadId != null ? { message_thread_id: w.threadId } : {}
    const arg = String(ctx.match ?? '').trim()
    const list = listMacros(d, w)
    if (/^add\b/.test(arg)) {
      const m = parseMacro(arg.slice(3))
      if (!m) return void ctx.reply(USAGE, thread)
      if (list.length >= MAX) return void ctx.reply(t('Не больше {MAX} команд в чате — удалите лишнюю: /macro del <n>', { MAX }), thread)
      save(d, w, [...list.filter(x => x.label !== m.label), m])
    } else if (/^del\b/.test(arg)) {
      const n = Number(arg.slice(3).trim())
      if (!Number.isInteger(n) || n < 1 || n > list.length) return void ctx.reply(t('Формат: /macro del <номер из списка>'), thread)
      save(d, w, list.filter((_, i) => i !== n - 1))
    } else if (arg) return void ctx.reply(USAGE, thread)
    const sc = macrosScreen(d, w)
    await ctx.reply(sc.text, { parse_mode: 'HTML', reply_markup: sc.kb, ...thread })
  })
}

export async function handleMacroCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^mc:(?:(l):(-?\d+):(\d+)|(r):(-?\d+):(\d+):(\d+)|list:([0-9a-f]+))$/.exec(data)
  if (!m) return false
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || !can(ctx.from.id, 'write')) {
    await answer(t('Нет доступа.'))
    return true
  }
  if (m[8]) {
    const s = d.sessions.get(m[8])
    if (!s) { await answer(t('Сессия уже отключена.')); return true }
    await answer()
    await show(ctx, macrosScreen(d, sessionChat(d, s), `sm:s:${s.id}`))
    return true
  }
  const chatId = m[2] ?? m[5]
  const thread = Number(m[3] ?? m[6])
  const w: Where = { chatId, threadId: thread ? thread : undefined }
  if (m[1] === 'l') {
    await answer()
    await show(ctx, macrosScreen(d, w))
    return true
  }
  const list = listMacros(d, w)
  const macro = list[Number(m[7])]
  if (!macro) { await answer(t('Этой команды уже нет.')); return true }
  await answer(`⚡ ${macro.label}`)
  await runMacro(d, w, macro, String(ctx.from.id))
  return true
}
