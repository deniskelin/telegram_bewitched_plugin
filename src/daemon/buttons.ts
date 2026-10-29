/**
 * Answer buttons: `ask_user` and `reply(buttons)` post a question with inline
 * buttons; a tap (or a text reply to the question) goes back to the session
 * as a regular <channel> event.
 */

import { InlineKeyboard, type Context } from 'grammy'
import { randomBytes } from 'crypto'
import { can } from '../access.ts'
import type { QuestionRow } from '../db.ts'
import { clip, safeMeta } from '../format.ts'
import type { ChatRef, Daemon, Session } from './daemon.ts'
import { button, type ButtonStyle } from './stream.ts'
import { t } from '../i18n/index.ts'

export type Option = { label: string; value?: string; style?: ButtonStyle }

export function parseOptions(raw: unknown): Option[] {
  if (!Array.isArray(raw)) throw new Error('options must be an array')
  const opts = raw.map(o => {
    if (typeof o === 'string') return { label: o }
    if (o && typeof o === 'object' && typeof (o as Option).label === 'string') {
      const { label, value, style } = o as Option
      return { label, value: value != null ? String(value) : undefined, style: (['primary', 'success', 'danger'] as const).includes(style as ButtonStyle) ? style : undefined }
    }
    throw new Error('each option needs a label')
  })
  if (opts.length < 1 || opts.length > 10) throw new Error('options: 1–10 items')
  for (const o of opts) {
    o.label = clip(o.label.trim(), 40)
    if (!o.label) throw new Error('option label is empty')
  }
  return opts
}

function keyboard(q: Pick<QuestionRow, 'id' | 'multi'>, opts: Option[], chosen: number[], closed: boolean): InlineKeyboard {
  const short = opts.every(o => o.label.length <= 12)
  const rows: ReturnType<typeof button>[][] = []
  opts.forEach((o, i) => {
    const picked = chosen.includes(i)
    const label = closed ? (picked ? `✅ ${o.label}` : o.label) : q.multi ? `${picked ? '☑️' : '▫️'} ${o.label}` : o.label
    const b = button(label, `q:${q.id}:${i}`, closed ? undefined : o.style, closed && !picked)
    if (short && rows.length && rows[rows.length - 1].length < 3) rows[rows.length - 1].push(b)
    else rows.push([b])
  })
  if (q.multi && !closed) rows.push([button(t('Готово'), `q:${q.id}:done`, 'primary')])
  return new InlineKeyboard(rows)
}

export async function postQuestion(
  d: Daemon,
  s: Session,
  chat: { chatId: string; threadId?: number },
  text: string,
  opts: Option[],
  o: { multi?: boolean; timeoutMin?: number; replyTo?: number },
): Promise<{ id: string; messageId: number }> {
  const id = randomBytes(4).toString('hex')
  const row: QuestionRow = {
    id,
    chat_id: chat.chatId,
    thread_id: chat.threadId ?? null,
    message_id: null,
    text,
    options: JSON.stringify(opts),
    multi: o.multi ? 1 : 0,
    chosen: '[]',
    project_key: s.projectKey,
    session_id: s.id,
    created_at: Date.now(),
    expires_at: o.timeoutMin ? Date.now() + o.timeoutMin * 60_000 : null,
    closed: 0,
  }
  d.store.addQuestion(row)
  const sent = await d.bot.api.sendMessage(chat.chatId, text, {
    ...(chat.threadId != null ? { message_thread_id: chat.threadId } : {}),
    ...(o.replyTo != null ? { reply_parameters: { message_id: o.replyTo } } : {}),
    reply_markup: keyboard(row, opts, [], false),
  })
  d.store.updateQuestion(id, { message_id: sent.message_id })
  return { id, messageId: sent.message_id }
}

/** Lock the keyboard: chosen marked ✅, the rest disabled (10.3) or removed. */
async function finalize(d: Daemon, q: QuestionRow, chosen: number[], note?: string): Promise<void> {
  if (q.message_id == null) return
  const opts = JSON.parse(q.options) as Option[]
  try {
    await d.bot.api.editMessageReplyMarkup(q.chat_id, q.message_id, { reply_markup: keyboard(q, opts, chosen, true) })
  } catch {
    const picked = chosen.map(i => opts[i]?.label).filter(Boolean).join(', ')
    await d.bot.api.editMessageText(q.chat_id, q.message_id, `${q.text}\n\n${note ?? `✅ ${picked}`}`).catch(() => {})
  }
}

/** Find who should get the answer: the asking session, its project, or queue it. */
function targetFor(d: Daemon, q: QuestionRow): Session | null {
  const byId = q.session_id ? d.sessions.get(q.session_id) : undefined
  if (byId && !byId.passive) return byId
  return q.project_key ? d.sessionForProject(q.project_key) : null
}

function deliverAnswer(d: Daemon, q: QuestionRow, chosen: number[], ctx: Context): void {
  const opts = JSON.parse(q.options) as Option[]
  const labels = chosen.map(i => opts[i]?.label ?? '?')
  const values = chosen.map(i => opts[i]?.value ?? opts[i]?.label ?? '?')
  const meta: Record<string, string> = {
    chat_id: q.chat_id,
    ...(q.thread_id != null ? { thread_id: String(q.thread_id) } : {}),
    event: 'answer',
    question_id: q.id,
    option_index: chosen.join(','),
    option_value: safeMeta(values.join(', ')) ?? '',
    user: safeMeta(ctx.from?.username ?? String(ctx.from?.id)) ?? '',
    user_id: String(ctx.from?.id ?? ''),
    ts: new Date().toISOString(),
  }
  const content = labels.join(', ')
  const s = targetFor(d, q)
  const from: ChatRef = { chatId: q.chat_id, threadId: q.thread_id ?? undefined, isPrivate: !q.chat_id.startsWith('-') }
  if (s) {
    if (q.session_id && s.id !== q.session_id) meta.stale = 'true'
    d.deliver(s, content, meta, from)
  } else if (q.project_key) {
    d.store.addPending(q.project_key, content, meta)
  }
}

export async function handleQuestionCallback(d: Daemon, ctx: Context, data: string): Promise<void> {
  const m = /^q:([0-9a-f]{8}):(\d+|done)$/.exec(data)
  if (!m) return void ctx.answerCallbackQuery().catch(() => {})
  if (!can(ctx.from!.id, 'answer')) return void ctx.answerCallbackQuery({ text: t('Нет доступа.') }).catch(() => {})
  const q = d.store.question(m[1])
  if (!q || q.closed) return void ctx.answerCallbackQuery({ text: t('На этот вопрос уже ответили.') }).catch(() => {})
  const opts = JSON.parse(q.options) as Option[]
  let chosen = JSON.parse(q.chosen) as number[]

  if (m[2] === 'done') {
    if (!chosen.length) return void ctx.answerCallbackQuery({ text: t('Ничего не выбрано.') }).catch(() => {})
  } else {
    const idx = Number(m[2])
    if (!(idx >= 0 && idx < opts.length)) return void ctx.answerCallbackQuery().catch(() => {})
    if (q.multi) {
      chosen = chosen.includes(idx) ? chosen.filter(i => i !== idx) : [...chosen, idx].sort((a, b) => a - b)
      d.store.updateQuestion(q.id, { chosen: JSON.stringify(chosen) })
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard(q, opts, chosen, false) }).catch(() => {})
      return void ctx.answerCallbackQuery().catch(() => {})
    }
    chosen = [idx]
  }

  d.store.updateQuestion(q.id, { chosen: JSON.stringify(chosen), closed: 1 })
  await ctx.answerCallbackQuery({ text: '✅' }).catch(() => {})
  await finalize(d, q, chosen)
  deliverAnswer(d, q, chosen, ctx)
}

/** A text reply to a question message closes the question; returns its id. */
export function closeByTextReply(d: Daemon, chatId: string, replyToId: number | undefined): string | null {
  if (replyToId == null) return null
  const q = d.store.questionByMessage(chatId, replyToId)
  if (!q || q.closed) return null
  d.store.updateQuestion(q.id, { closed: 1 })
  void finalize(d, q, [], t('✍️ Ответ текстом'))
  return q.id
}

export function startQuestionExpiry(d: Daemon): void {
  setInterval(() => {
    for (const q of d.store.expiredQuestions()) {
      d.store.updateQuestion(q.id, { closed: 1 })
      void finalize(d, q, [], t('⌛ Время ответа истекло'))
    }
  }, 60_000).unref()
}
