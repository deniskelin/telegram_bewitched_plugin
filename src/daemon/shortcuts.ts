/**
 * FR-9: messages the daemon can answer itself, so the session never wakes
 * for them — a turn re-reads the whole context, however short the reply.
 *
 * - a Claude Code command (/context, /rename…): offered to be typed into the
 *   session's window (the owner), not sent as text to the model;
 * - «стоп» / «хватит» / «stop» during a turn: ⏹, not a message in the queue;
 * - «статус» / «ты тут?» / «ping»: the session's state; «лимиты»: /usage;
 * - «ок» / «👍» / «спасибо» right after an answer that asked nothing: a 👌
 *   reaction (SKIP_ACKS=off sends them on);
 * - the same text again within 10 s: a double tap, dropped.
 *
 * Each one counts in /usage («🤖 без модели»). /clear, /compact, /model, /cost
 * are in sessionCommandScreen (menu.ts).
 */

import { InlineKeyboard, type Context } from 'grammy'
import { randomBytes } from 'crypto'
import { can, owner } from '../access.ts'
import { escapeHtml, fmtDuration } from '../format.ts'
import { t } from '../i18n/index.ts'
import type { Daemon, Session } from './daemon.ts'
import { stopSession } from './inbound.ts'
import { show } from './menu.ts'
import { statusLabel } from './report.ts'
import { button } from './stream.ts'
import { usageReport, usageKeyboard } from './usage.ts'

// i18n-ignore: words people type (Russian and English), matched whatever the interface language
const STOP_RE = /^\s*(стоп|хватит|отмена|остановись|stop|cancel|halt)[\s.!]*$/i
// i18n-ignore: as above
const STATUS_RE = /^\s*(статус|status|ты тут|ты здесь|жив|живой|ping|пинг|are you there)[\s?!.]*$/i
// i18n-ignore: as above
const LIMITS_RE = /^\s*(лимит|лимиты|сколько лимита|limits?|usage)[\s?!.]*$/i
// i18n-ignore: as above
const ACK_RE = /^\s*(ок|окей|ok|okay|ага|угу|понял|поняла|ясно|спасибо|спс|благодарю|thanks|thank you|thx|👍|👌|🙏|❤️|✅)[\s.!)]*$/i
/** A bot command the bot does not know: Claude Code's, for the window. */
const SLASH_RE = /^\/[a-z][\w:-]*(?:@\w+)?(?:\s[\s\S]*)?$/i

/** Count a turn the model did not have to make, by kind. */
function saved(d: Daemon, kind: string): void {
  d.store.set('fr9:saved', String(Number(d.store.get('fr9:saved') ?? 0) + 1))
  d.store.set(`fr9:saved:${kind}`, String(Number(d.store.get(`fr9:saved:${kind}`) ?? 0) + 1))
}

/** «🤖 Без модели: 12 (стоп 3, статус 2, …)» for /usage; null before the first one. */
export function savedLine(d: Daemon): string | null {
  const n = Number(d.store.get('fr9:saved') ?? 0)
  if (!n) return null
  const kinds: [string, string][] = [['cmd', t('команды')], ['stop', t('стоп')], ['status', t('статус')], ['limits', t('лимиты')], ['ack', t('«ок»')], ['dup', t('повторы')]]
  const parts = kinds.map(([k, name]) => [name, Number(d.store.get(`fr9:saved:${k}`) ?? 0)] as const).filter(([, v]) => v > 0).map(([name, v]) => `${name} ${v}`)
  return t('🤖 Без запроса к модели: {n} ({v})', { n, v: parts.join(', ') })
}

/** Last texts per chat and sender: the same one again within 10 s is a double send. */
const recent = new Map<string, { text: string; at: number }>()

/** fx:send — deliver the command as a message after all (in memory: a restart drops the offer). */
const pendingSend = new Map<string, () => void>()

/** The last thing the bot said in this chat asked something: «ок» is an answer then. */
function lastOutAsked(d: Daemon, chatId: string, threadId: number | undefined): boolean {
  const last = d.store.history(chatId, threadId ?? null, 6).filter(m => m.direction === 'out').at(-1)
  return !last || /\?\s*$/.test(last.text ?? '')
}

export type Here = { chatId: string; threadId?: number; messageId: number; from: number }

/**
 * Handle text meant for session s without the model. true — handled (the
 * caller stops); false — deliver as usual.
 */
export async function withoutModel(d: Daemon, ctx: Context, text: string, s: Session, here: Here, deliver: (s: Session, text: string) => void): Promise<boolean> {
  // A spoken «стоп» arrives as «🎤 стоп».
  text = text.replace(/^🎤\s*/, '').trim()
  const reply = (html: string, kb?: InlineKeyboard) =>
    ctx.reply(html, { parse_mode: 'HTML', ...(here.threadId != null ? { message_thread_id: here.threadId } : {}), ...(kb ? { reply_markup: kb } : {}) }).catch(err => d.log(`shortcut reply failed: ${err}`))
  const react = (emoji: string) => d.bot.api.setMessageReaction(here.chatId, here.messageId, [{ type: 'emoji', emoji: emoji as never }]).catch(() => {})

  // A double tap: the same text from the same person within 10 s.
  const key = `${here.chatId}:${here.threadId ?? 0}:${here.from}`
  const prev = recent.get(key)
  recent.set(key, { text, at: Date.now() })
  if (prev && prev.text === text && Date.now() - prev.at < 10_000) {
    saved(d, 'dup')
    return true
  }

  if (STOP_RE.test(text) && s.status === 'working') {
    if (!can(here.from, 'stop')) return false
    stopSession(d, s)
    await react('👌')
    saved(d, 'stop')
    return true
  }

  if (STATUS_RE.test(text)) {
    const ago = fmtDuration(Date.now() - s.lastActivity)
    const kb = can(here.from, 'control') ? new InlineKeyboard([[button(t('📋 Карточка сессии'), `sm:s:${s.id}`)]]) : undefined
    await reply(t('{status} · #{id}, активность {ago} назад', { status: statusLabel(s), id: s.id, ago }), kb)
    saved(d, 'status')
    return true
  }

  if (LIMITS_RE.test(text) && String(here.from) === owner()) {
    await reply(await usageReport(d), usageKeyboard(d))
    saved(d, 'limits')
    return true
  }

  if (ACK_RE.test(text) && process.env.SKIP_ACKS !== 'off' && s.status !== 'working' && !lastOutAsked(d, here.chatId, here.threadId)) {
    await react('👌')
    saved(d, 'ack')
    return true
  }

  if (SLASH_RE.test(text) && can(here.from, 'control') && s.tmuxPane) {
    const id = randomBytes(4).toString('hex')
    d.store.set(`fr9:cmd:${id}`, JSON.stringify({ session: s.id, text: text.replace(/^(\/[\w:-]+)@\w+/, '$1') }))
    pendingSend.set(id, () => deliver(s, text))
    const kb = new InlineKeyboard([[button(t('⌨️ Набрать в окне сессии'), `fx:type:${id}`, 'primary'), button(t('💬 Отправить Claude'), `fx:send:${id}`)]])
    await reply(t('<code>{cmd}</code> похоже на команду Claude Code. Набрать её в окне сессии или отправить Claude как сообщение?', { cmd: escapeHtml(text.slice(0, 200)) }), kb)
    saved(d, 'cmd')
    return true
  }
  return false
}

/** fx:type:<id> — type the command into the window; fx:send:<id> — deliver it as a message after all. */
export async function handleShortcutCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^fx:(type|send):([0-9a-f]{8})$/.exec(data)
  if (!m) return false
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || !can(ctx.from.id, 'control')) { await answer(t('Нет доступа.')); return true }
  const raw = d.store.get(`fr9:cmd:${m[2]}`)
  const r = raw ? JSON.parse(raw) as { session: string; text: string } : null
  const s = r ? d.sessions.get(r.session) : undefined
  if (!r || !s) { await answer(t('Уже неактуально.')); return true }
  d.store.set(`fr9:cmd:${m[2]}`, null)
  if (m[1] === 'type') pendingSend.delete(m[2])
  if (m[1] === 'send') {
    const send = pendingSend.get(m[2])
    pendingSend.delete(m[2])
    if (!send) { await answer(t('Уже неактуально.')); return true }
    send()
    await answer(t('💬 Отправил Claude'))
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
    return true
  }
  if (!s.tmuxPane) { await answer(t('Сессия не в tmux — команды не отправить.')); return true }
  if (s.turn || s.status !== 'idle') { await answer(t('Сессия работает — дождитесь конца хода или нажмите ⏹.')); return true }
  await d.tmuxType(s.tmuxPane, r.text)
  await answer(`➡️ ${r.text.slice(0, 150)}`)
  const pane = /^%\d+$/.test(s.tmuxPane) ? `tx:p${s.tmuxPane.slice(1)}` : null
  await show(ctx, { text: t('⌨️ Набрал в окне сессии #{id}: <code>{cmd}</code>', { id: s.id, cmd: escapeHtml(r.text.slice(0, 200)) }), kb: new InlineKeyboard(pane ? [[button(t('👁 Экран и клавиши'), pane, 'primary')]] : []) })
  return true
}
