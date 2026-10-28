/**
 * ⏰ Reminders and deferred tasks: "/remind 2h проверь CI" in a chat, or the
 * `remind` tool from a session. When due, the text is posted in that chat and
 * delivered to the session that serves it (started if needed), like a
 * message from the user who set it.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { randomBytes } from 'crypto'
import { isOwner } from '../access.ts'
import { escapeHtml } from '../format.ts'
import type { ChatRef, Daemon } from './daemon.ts'
import { button } from './stream.ts'

export type Reminder = {
  id: string
  chatId: string
  threadId?: number
  text: string
  at: number
  daily: boolean
  /** Who set it: the message is delivered as theirs. */
  userId: string
}

// --------------------------------------------------------------------------
// "when" parsing
// --------------------------------------------------------------------------

const UNIT_MS: Record<string, number> = { m: 60_000, м: 60_000, h: 3_600_000, ч: 3_600_000, d: 86_400_000, д: 86_400_000 }

/** Next occurrence of HH:MM (today if still ahead, else tomorrow). */
function nextTime(h: number, m: number, now: number, tomorrow = false): number | null {
  if (h > 23 || m > 59) return null
  const t = new Date(now)
  t.setHours(h, m, 0, 0)
  if (tomorrow || t.getTime() <= now) t.setDate(t.getDate() + 1)
  return t.getTime()
}

/**
 * "30m …", "1h30m …", "через 2 часа …", "18:30 …", "завтра 9:00 …",
 * "каждый день 9:00 …" → when, repeat and the rest of the text.
 */
export function parseWhen(input: string, now = Date.now()): { at: number; daily: boolean; text: string } | null {
  const s = input.trim()
  let m = /^((?:\d+\s*[mhdмчд])+)\s+([\s\S]+)$/i.exec(s)
  if (m) {
    let ms = 0
    for (const [, n, u] of m[1].matchAll(/(\d+)\s*([mhdмчд])/gi)) ms += Number(n) * UNIT_MS[u.toLowerCase()]
    return ms > 0 ? { at: now + ms, daily: false, text: m[2].trim() } : null
  }
  m = /^через\s+(\d+)\s*(мин[а-яё]*|час[а-яё]*|д(?:ень|ня|ней))\s+([\s\S]+)$/i.exec(s)
  if (m) {
    const unit = m[2].toLowerCase().startsWith('мин') ? 'm' : m[2].toLowerCase().startsWith('час') ? 'h' : 'd'
    return { at: now + Number(m[1]) * UNIT_MS[unit], daily: false, text: m[3].trim() }
  }
  m = /^(каждый день|ежедневно|daily)\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i.exec(s)
  if (m) {
    const at = nextTime(Number(m[2]), Number(m[3]), now)
    return at ? { at, daily: true, text: m[4].trim() } : null
  }
  m = /^(завтра\s+)?(?:в\s+)?(\d{1,2}):(\d{2})\s+([\s\S]+)$/i.exec(s)
  if (m) {
    const at = nextTime(Number(m[2]), Number(m[3]), now, !!m[1])
    return at ? { at, daily: false, text: m[4].trim() } : null
  }
  return null
}

export function fmtWhen(r: Pick<Reminder, 'at' | 'daily'>, now = Date.now()): string {
  const t = new Date(r.at)
  const time = t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  if (r.daily) return `каждый день в ${time}`
  const day = new Date(now).toDateString() === t.toDateString() ? 'сегодня' : t.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
  return `${day} в ${time}`
}

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

export function listReminders(d: Daemon): Reminder[] {
  try {
    return JSON.parse(d.store.get('reminders') ?? '[]')
  } catch {
    return []
  }
}

function saveReminders(d: Daemon, list: Reminder[]): void {
  d.store.set('reminders', JSON.stringify(list))
}

export function addReminder(d: Daemon, r: Omit<Reminder, 'id'>): Reminder {
  const full = { ...r, id: randomBytes(3).toString('hex') }
  saveReminders(d, [...listReminders(d), full])
  return full
}

function removeReminder(d: Daemon, id: string): boolean {
  const list = listReminders(d)
  const rest = list.filter(r => r.id !== id)
  saveReminders(d, rest)
  return rest.length !== list.length
}

// --------------------------------------------------------------------------
// Firing
// --------------------------------------------------------------------------

/** Post due reminders and hand them to the chat's session; daily ones move to tomorrow. */
export async function fireDue(d: Daemon, now = Date.now()): Promise<void> {
  const list = listReminders(d)
  const due = list.filter(r => r.at <= now)
  if (!due.length) return
  const keep = list.filter(r => r.at > now)
  for (const r of due) {
    if (r.daily) {
      let at = r.at
      while (at <= now) at += 86_400_000
      keep.push({ ...r, at })
    }
  }
  saveReminders(d, keep)
  for (const r of due) {
    const thread = r.threadId != null ? { message_thread_id: r.threadId } : {}
    await d.bot.api.sendMessage(r.chatId, `⏰ ${r.text}`, thread).catch(err => d.log(`reminder ${r.id} post failed: ${err}`))
    const chat: ChatRef = { chatId: r.chatId, threadId: r.threadId, isPrivate: !r.chatId.startsWith('-') }
    const meta: Record<string, string> = {
      chat_id: r.chatId, ...(r.threadId != null ? { thread_id: String(r.threadId) } : {}),
      user_id: r.userId, user: r.userId, ts: new Date(now).toISOString(), event: 'reminder', reminder_id: r.id,
    }
    await d.routeText(chat, r.userId, `⏰ Напоминание (${fmtWhen(r, now)}): ${r.text}`, meta).catch(err => d.log(`reminder ${r.id} delivery failed: ${err}`))
  }
}

export function startReminders(d: Daemon): void {
  setInterval(() => void fireDue(d).catch(err => d.log(`reminders failed: ${err}`)), 15_000).unref?.()
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

const USAGE = 'Формат: /remind <когда> <текст>\nКогда: 30m, 1h30m, 2d, «через 2 часа», 18:30, «завтра 9:00», «каждый день 9:00».\nПример: /remind 2h проверь CI'

function threadOf(ctx: Context): number | undefined {
  return ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined
}

/** This chat's reminders (in a topic: the topic's), with a 🗑 for each. */
function remindersScreen(d: Daemon, chatId: string, threadId: number | undefined): { text: string; kb: InlineKeyboard } {
  const mine = listReminders(d).filter(r => r.chatId === chatId && r.threadId === threadId).sort((a, b) => a.at - b.at)
  const lines = [`⏰ <b>Напоминания</b> (${mine.length})`]
  for (const r of mine) lines.push(`• ${fmtWhen(r)} — ${escapeHtml(r.text.length > 100 ? r.text.slice(0, 99) + '…' : r.text)}`)
  if (!mine.length) lines.push('Нет. ' + escapeHtml(USAGE.split('\n')[0]))
  const kb = new InlineKeyboard(mine.slice(0, 20).map(r => [button(`🗑 ${fmtWhen(r)} · ${r.text}`.slice(0, 40), `rm:del:${r.id}`)]))
  return { text: lines.join('\n'), kb }
}

export function registerReminderCommands(d: Daemon, bot: Bot): void {
  bot.command('remind', async ctx => {
    if (!ctx.from || !isOwner(ctx.from.id) || !ctx.chat) return
    const parsed = parseWhen(String(ctx.match ?? ''))
    const thread = threadOf(ctx)
    if (!parsed || !parsed.text) return void ctx.reply(USAGE, { message_thread_id: thread })
    const r = addReminder(d, { chatId: String(ctx.chat.id), threadId: thread, text: parsed.text, at: parsed.at, daily: parsed.daily, userId: String(ctx.from.id) })
    await ctx.reply(`⏰ Напомню ${fmtWhen(r)}: ${r.text}`, { message_thread_id: thread, reply_markup: new InlineKeyboard([[button('🗑 Отменить', `rm:del:${r.id}`)]]) })
  })

  bot.command('reminders', async ctx => {
    if (!ctx.from || !isOwner(ctx.from.id) || !ctx.chat) return
    const { text, kb } = remindersScreen(d, String(ctx.chat.id), threadOf(ctx))
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb, message_thread_id: threadOf(ctx) })
  })
}

export async function handleReminderCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^rm:del:([0-9a-f]+)$/.exec(data)
  if (!m) return false
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: 'Нет доступа.' }).catch(() => {})
    return true
  }
  const ok = removeReminder(d, m[1])
  await ctx.answerCallbackQuery({ text: ok ? '🗑 Напоминание удалено' : 'Уже нет' }).catch(() => {})
  const msg = ctx.callbackQuery?.message
  if (msg && 'text' in msg && msg.text?.startsWith('⏰ Напомню')) await ctx.editMessageText(`${msg.text}\n\n🗑 Отменено`).catch(() => {})
  else if (msg && ctx.chat) {
    const { text, kb } = remindersScreen(d, String(ctx.chat.id), msg.message_thread_id)
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
  }
  return true
}
