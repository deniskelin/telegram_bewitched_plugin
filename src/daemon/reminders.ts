/**
 * ⏰ Reminders and deferred tasks: "/remind 2h проверь CI" in a chat, or the
 * `remind` tool from a session. When due, the text is posted in that chat and
 * delivered to the session that serves it (started if needed), like a
 * message from the user who set it.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { randomBytes } from 'crypto'
import { can } from '../access.ts'
import { clip, escapeHtml, fmtDuration } from '../format.ts'
import { liveTime } from '../rich.ts'
import type { ChatRef, Daemon } from './daemon.ts'
import { button } from './stream.ts'
import { locale, t as tr } from '../i18n/index.ts'
import { inChat } from './lang.ts'

export type Reminder = {
  id: string
  chatId: string
  threadId?: number
  text: string
  at: number
  daily: boolean
  /** Who set it: the message is delivered as theirs. */
  userId: string
  /** Repeat every N minutes (FR-7; daily is the 24 h case kept for old rows). */
  everyMin?: number
  /** user: /remind in a chat; session: the remind tool (FR-7). Old rows: user. */
  by?: 'user' | 'session'
  /** task: an instruction for the session (default); note: only posted to the chat, no session is woken. */
  mode?: 'task' | 'note'
  /** F05, a retry of a failed firing: the time it was due, the parts already done, tries so far. */
  retry?: { due: number; posted: boolean; delivered: boolean; tries: number; repeats?: boolean }
}

/** A firing that failed is tried again after this, up to RETRY_MAX times in all. */
const RETRY_MS = 60_000
const RETRY_MAX = 5

/** Repeat period in ms, or 0 for a one-off. */
export function periodMs(r: Pick<Reminder, 'daily' | 'everyMin'>): number {
  return r.everyMin && r.everyMin > 0 ? r.everyMin * 60_000 : r.daily ? 86_400_000 : 0
}

/** "опоздало на N мин" threshold: the timer ticks every 15 s, so anything later than this was missed while the daemon was down. */
const LATE_MS = 2 * 60_000

// --------------------------------------------------------------------------
// "when" parsing
// --------------------------------------------------------------------------

// Time words are parsed in Russian and English, whatever the interface language (i18n-ignore).
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
 * "каждый день 9:00 …" (and in English: "in 2 hours …", "tomorrow 9:00 …",
 * "every day 9:00 …") → when, repeat and the rest of the text. Parsing is the
 * same in every interface language.
 */
export function parseWhen(input: string, now = Date.now()): { at: number; daily: boolean; everyMin?: number; text: string } | null {
  const s = input.trim()
  // "каждые 2h …", "каждый час …", "every 30m …": a repeating reminder, first one after the period.
  let m = /^(?:кажд(?:ые|ый|ую)|every)\s+((?:\d+\s*[mhdмчд])+|час|hour|\d+\s*(?:мин[а-яё]*|час[а-яё]*|min(?:ute)?s?|h(?:ou)?rs?))\s+([\s\S]+)$/i.exec(s) // i18n-ignore
  if (m) {
    let ms = 0
    const u = m[1].toLowerCase()
    if (u === 'час' || u === 'hour') ms = 3_600_000 // i18n-ignore
    else if (/^\d+\s*(мин|min)/.test(u)) ms = Number.parseInt(u) * 60_000 // i18n-ignore
    else if (/^\d+\s*(час|h(?:ou)?r)/.test(u) && !/^\d+\s*h\d/.test(u)) ms = Number.parseInt(u) * 3_600_000 // i18n-ignore
    else for (const [, n, x] of u.matchAll(/(\d+)\s*([mhdмчд])/gi)) ms += Number(n) * UNIT_MS[x.toLowerCase()] // i18n-ignore
    return ms >= 60_000 ? { at: now + ms, daily: false, everyMin: Math.round(ms / 60_000), text: m[2].trim() } : null
  }
  m = /^((?:\d+\s*[mhdмчд])+)\s+([\s\S]+)$/i.exec(s) // i18n-ignore
  if (m) {
    let ms = 0
    for (const [, n, u] of m[1].matchAll(/(\d+)\s*([mhdмчд])/gi)) ms += Number(n) * UNIT_MS[u.toLowerCase()] // i18n-ignore
    return ms > 0 ? { at: now + ms, daily: false, text: m[2].trim() } : null
  }
  // i18n-ignore
  m = /^(?:через|in)\s+(\d+)\s*(мин[а-яё]*|час[а-яё]*|д(?:ень|ня|ней)|min(?:ute)?s?|h(?:ou)?rs?|hours?|days?)\s+([\s\S]+)$/i.exec(s)
  if (m) {
    const u = m[2].toLowerCase()
    const unit = /^(мин|min)/.test(u) ? 'm' : /^(час|h)/.test(u) ? 'h' : 'd' // i18n-ignore
    return { at: now + Number(m[1]) * UNIT_MS[unit], daily: false, text: m[3].trim() }
  }
  m = /^(каждый день|ежедневно|daily|every day)\s+(?:at\s+)?(\d{1,2}):(\d{2})\s+([\s\S]+)$/i.exec(s) // i18n-ignore
  if (m) {
    const at = nextTime(Number(m[2]), Number(m[3]), now)
    return at ? { at, daily: true, text: m[4].trim() } : null
  }
  m = /^((?:завтра|tomorrow)\s+)?(?:(?:в|at)\s+)?(\d{1,2}):(\d{2})\s+([\s\S]+)$/i.exec(s) // i18n-ignore
  if (m) {
    const at = nextTime(Number(m[2]), Number(m[3]), now, !!m[1])
    return at ? { at, daily: false, text: m[4].trim() } : null
  }
  return null
}

export function fmtWhen(r: Pick<Reminder, 'at' | 'daily' | 'everyMin'>, now = Date.now()): string {
  const t = new Date(r.at)
  const time = t.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  if (r.everyMin && r.everyMin > 0) {
    const every = r.everyMin % 60 === 0 ? tr('{n} ч', { n: r.everyMin / 60 }) : tr('{n} мин', { n: r.everyMin })
    return tr('каждые {every}, следующее в {time}', { every, time })
  }
  if (r.daily) return tr('каждый день в {time}', { time })
  const day = new Date(now).toDateString() === t.toDateString() ? tr('сегодня') : t.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' })
  return tr('{day} в {time}', { day, time })
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
  // F05: every firing stays in the store as a retry until it went through — a failed post, a failed
  // delivery or a daemon that died meanwhile no longer loses it. A repeating reminder's next time is its own row.
  const firing = due.map(r => {
    const retry = r.retry ?? { due: r.at, posted: false, delivered: r.mode === 'note', tries: 0, repeats: periodMs(r) > 0 }
    return { ...r, id: r.retry ? r.id : periodMs(r) ? `${r.id}~${r.at}` : r.id, daily: false, everyMin: undefined, at: now + RETRY_MS, retry: { ...retry, tries: retry.tries + 1 } }
  })
  for (const r of due) {
    const period = periodMs(r)
    if (period && !r.retry) {
      let at = r.at
      while (at <= now) at += period
      keep.push({ ...r, at })
    }
  }
  saveReminders(d, [...keep, ...firing])
  for (const f of firing) {
    const r = { ...f, at: f.retry.due }
    const ok = await fireOne(d, r, f.retry, now)
    const left = listReminders(d).filter(x => x.id !== f.id)
    if (ok.posted && ok.delivered) { saveReminders(d, left); continue }
    if (f.retry.tries >= RETRY_MAX) {
      d.log(`reminder ${f.id}: gave up after ${f.retry.tries} tries`)
      saveReminders(d, left)
      continue
    }
    d.log(`reminder ${f.id}: ${ok.posted ? 'delivery' : 'post'} failed, retry ${f.retry.tries + 1}/${RETRY_MAX} in ${RETRY_MS / 1000} s`)
    saveReminders(d, [...left, { ...f, retry: { ...f.retry, ...ok } }])
  }
}

/** One firing: the post in the chat, then (a task) the session. What already went through is not repeated. */
async function fireOne(d: Daemon, r: Reminder, done: { posted: boolean; delivered: boolean }, now: number): Promise<{ posted: boolean; delivered: boolean }> {
  let posted = done.posted
  let delivered = done.delivered
  {
    const lateMin = now - r.at > LATE_MS ? Math.round((now - r.at) / 60_000) : 0
    const late = () => (lateMin ? ' ' + tr('(опоздало на {n} мин: демон не работал)', { n: lateMin }) : '')
    const thread = r.threadId != null ? { message_thread_id: r.threadId } : {}
    const head = r.by === 'session' ? '⏰🤖' : '⏰'
    const line = inChat(d, r.chatId, r.threadId, () => `${head} ${r.text}${late()}`)
    if (!posted) posted = await d.bot.api.sendMessage(r.chatId, line, thread).then(() => true, err => { d.log(`reminder ${r.id} post failed: ${err}`); return false })
    // A note is for the people in the chat only: no session is woken for it.
    if (r.mode === 'note' || delivered) return { posted, delivered: true }
    const chat: ChatRef = { chatId: r.chatId, threadId: r.threadId, isPrivate: !r.chatId.startsWith('-') }
    const meta: Record<string, string> = {
      chat_id: r.chatId, ...(r.threadId != null ? { thread_id: String(r.threadId) } : {}),
      user_id: r.userId, user: r.userId, ts: new Date(now).toISOString(), event: 'reminder', reminder_id: r.id.replace(/~\d+$/, ''),
      reminder_by: r.by ?? 'user', ...(lateMin ? { late_min: String(lateMin) } : {}),
      ...(periodMs(r) || r.retry?.repeats ? { repeats: 'true' } : {}),
    }
    const text = inChat(d, r.chatId, r.threadId, () => (r.by === 'session'
      ? tr('⏰ Задача, которую вы поставили себе ({when}): {text}', { when: fmtWhen(r, now), text: r.text })
      : tr('⏰ Напоминание ({when}): {text}', { when: fmtWhen(r, now), text: r.text })) + late())
    delivered = await inChat(d, r.chatId, r.threadId, () => d.routeText(chat, r.userId, text, meta)).then(() => true, err => { d.log(`reminder ${r.id} delivery failed: ${err}`); return false })
  }
  return { posted, delivered }
}

/** Active reminders of a chat/topic, as lines for the model (session_resume; FR-7). Not translated: text for the model. */
export function remindersForModel(d: Daemon, chatId: string, threadId: number | undefined): string | null {
  const mine = listReminders(d).filter(r => r.chatId === chatId && r.threadId === threadId).sort((a, b) => a.at - b.at)
  if (!mine.length) return null
  const lines = mine.map(r => {
    const rep = r.everyMin ? `, every ${r.everyMin} min` : r.daily ? ', daily' : ''
    return `- ${r.id}: ${new Date(r.at).toISOString()}${rep}, set by ${r.by ?? 'user'}${r.mode === 'note' ? ' (note)' : ''}: ${r.text}`
  })
  return `Active reminders in this chat (the daemon fires them; cancel with cancel_reminder):\n${lines.join('\n')}`
}

/** Remove a reminder (the cancel_reminder tool, 🗑). */
export function cancelReminder(d: Daemon, id: string): boolean {
  return removeReminder(d, id)
}

export function startReminders(d: Daemon): void {
  setInterval(() => void fireDue(d).catch(err => d.log(`reminders failed: ${err}`)), 15_000).unref?.()
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

const USAGE = () => tr('Формат: /remind <когда> <текст>\nКогда: 30m, 1h30m, 2d, «через 2 часа», 18:30, «завтра 9:00», «каждый день 9:00», «каждые 2h».\nПример: /remind 2h проверь CI')

function threadOf(ctx: Context): number | undefined {
  return ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined
}

/** This chat's reminders (in a topic: the topic's), with a 🗑 for each. */
export function remindersScreen(d: Daemon, chatId: string, threadId: number | undefined): { text: string; kb: InlineKeyboard } {
  const mine = listReminders(d).filter(r => r.chatId === chatId && r.threadId === threadId).sort((a, b) => a.at - b.at)
  const lines = [tr('⏰ <b>Напоминания</b> ({n})', { n: mine.length })]
  for (const r of mine) {
    const who = r.by === 'session' ? tr('🤖 сессия') : tr('👤 пользователь')
    const note = r.mode === 'note' ? ' · ' + tr('только в чат') : ''
    // FR-12: the next time as live time in a rich screen («через 1 ч 12 мин»), the date and time in the fallback.
    lines.push(`• ${fmtWhen(r)} (${liveTime(r.at, tr('через {v}', { v: fmtDuration(Math.max(0, r.at - Date.now())) }))}) — ${escapeHtml(r.text.length > 100 ? r.text.slice(0, 99) + '…' : r.text)} <i>(${who}${note})</i>`)
  }
  if (!mine.length) lines.push(tr('Нет.') + ' ' + escapeHtml(USAGE().split('\n')[0]))
  const kb = new InlineKeyboard([...mine.slice(0, 20).map(r => [button(clip(`🗑 ${fmtWhen(r)} · ${r.text}`, 40), `rm:del:${r.id}`)]), [button(tr('« Меню'), 'hub:main')]])
  return { text: lines.join('\n'), kb }
}

export function registerReminderCommands(d: Daemon, bot: Bot): void {
  bot.command('remind', async ctx => {
    if (!ctx.from || !can(ctx.from.id, 'write') || !ctx.chat) return
    const parsed = parseWhen(String(ctx.match ?? ''))
    const thread = threadOf(ctx)
    if (!parsed || !parsed.text) return void ctx.reply(USAGE(), { message_thread_id: thread })
    const r = addReminder(d, { chatId: String(ctx.chat.id), threadId: thread, text: parsed.text, at: parsed.at, daily: parsed.daily, everyMin: parsed.everyMin, userId: String(ctx.from.id), by: 'user' })
    await ctx.reply(tr('⏰ Напомню {when}: {text}', { when: fmtWhen(r), text: r.text }), { message_thread_id: thread, reply_markup: new InlineKeyboard([[button(tr('🗑 Отменить'), `rm:del:${r.id}`)]]) })
  })

  bot.command('reminders', async ctx => {
    if (!ctx.from || !can(ctx.from.id, 'write') || !ctx.chat) return
    const { text, kb } = remindersScreen(d, String(ctx.chat.id), threadOf(ctx))
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb, message_thread_id: threadOf(ctx) })
  })
}

export async function handleReminderCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^rm:del:([0-9a-f]+)$/.exec(data)
  if (!m) return false
  if (!ctx.from || !can(ctx.from.id, 'write')) {
    await ctx.answerCallbackQuery({ text: tr('Нет доступа.') }).catch(() => {})
    return true
  }
  const ok = removeReminder(d, m[1])
  await ctx.answerCallbackQuery({ text: ok ? tr('🗑 Напоминание удалено') : tr('Уже нет') }).catch(() => {})
  const msg = ctx.callbackQuery?.message
  if (msg && 'text' in msg && msg.text?.startsWith('⏰')) await ctx.editMessageText(`${msg.text}\n\n${tr('🗑 Отменено')}`).catch(() => {})
  else if (msg && ctx.chat) {
    const { text, kb } = remindersScreen(d, String(ctx.chat.id), msg.message_thread_id)
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
  }
  return true
}
