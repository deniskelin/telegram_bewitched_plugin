/** Persistent UI state. A transport dispatch is not an acknowledgement from the agent. */
import { randomBytes } from 'crypto'
import { InlineKeyboard, type Context } from 'grammy'
import { can } from '../access.ts'
import { clip, escapeHtml, maskSecrets } from '../format.ts'
import { t, k } from '../i18n/index.ts'
import { inChat } from './lang.ts'
import type { Daemon, Session, ChatRef } from './daemon.ts'
import { button } from './stream.ts'

export type Phase = 'question' | 'received' | 'launching' | 'queued' | 'sent' | 'working' | 'done' | 'failed' | 'stopped'
const LABEL: Record<Phase, string> = { question: k('Ждёт вашего выбора'), received: k('Получено ботом'), launching: k('Ждёт запуска'), queued: k('В очереди'), sent: k('Передано агенту'), working: k('Агент начал работу'), done: k('Готово'), failed: k('Не доставлено'), stopped: k('Остановлено') }
export type Delivery = { id: string; chat: ChatRef; messageId: string; userId: string; phase: Phase; at: number; updated: number; card?: number; project?: string; session?: string }
const key = (chat: string, id: string) => `ux:delivery:${chat}:${id}`
const pendingRenders = new WeakMap<Daemon, Set<string>>()
const rendering = new WeakMap<Daemon, Set<string>>()
export function receiveMessage(d: Daemon, chat: ChatRef, messageId: string, userId: string): void {
  const id = key(chat.chatId, messageId)
  if (d.store.get(id)) return
  d.store.set(id, JSON.stringify({ id, chat, messageId, userId, phase: 'received', at: Date.now(), updated: Date.now() } satisfies Delivery))
  renderSoon(d, id, 1500)
}
export function deliveryPhase(d: Daemon, meta: Record<string, string>, phase: Phase, s?: Session): void {
  const ids = (meta.message_ids ?? meta.message_id ?? '').split(',').filter(Boolean)
  for (const messageId of ids) {
    const id = key(meta.chat_id ?? s?.lastChat?.chatId ?? '', messageId)
    const raw = d.store.get(id)
    if (!raw) continue
    const r: Delivery = JSON.parse(raw)
    if (r.phase === 'working' && ['received', 'queued', 'launching', 'sent'].includes(phase)) continue
    if (['done', 'stopped'].includes(r.phase) && phase !== 'done') continue
    r.phase = phase; r.updated = Date.now()
    if (s) {
      r.session = s.id; r.project = s.projectKey
      if (phase === 'failed') d.store.set(`ux:error:${s.projectKey}`, String(Date.now()))
    }
    d.store.set(id, JSON.stringify(r)); renderSoon(d, id, 100)
  }
  if (s && ids.length && phase === 'sent') {
    const previous = JSON.parse(d.store.get(`ux:active:${s.id}`) ?? '[]') as Record<string, string>[]
    const unique = previous.filter(x => !(x.chat_id === meta.chat_id && x.message_ids === ids.join(',')))
    d.store.set(`ux:active:${s.id}`, JSON.stringify([...unique, { ...meta, message_ids: ids.join(',') }].slice(-100)))
  }
}
export function sessionPhase(d: Daemon, s: Session, phase: Phase): void {
  if (phase === 'failed') d.store.set(`ux:error:${s.projectKey}`, String(Date.now()))
  if (phase === 'working' || phase === 'done') d.store.set(`ux:error:${s.projectKey}`, null)
  const raw = d.store.get(`ux:active:${s.id}`)
  if (raw) for (const meta of JSON.parse(raw) as Record<string, string>[]) deliveryPhase(d, meta, phase)
  if (phase === 'done' || phase === 'failed' || phase === 'stopped') d.store.set(`ux:active:${s.id}`, null)
}
function renderSoon(d: Daemon, id: string, delay: number): void {
  if (process.env.DELIVERY_CARDS === 'off') return
  let scheduled = pendingRenders.get(d)
  if (!scheduled) { scheduled = new Set(); pendingRenders.set(d, scheduled) }
  if (scheduled.has(id)) return
  scheduled.add(id)
  setTimeout(() => {
    scheduled!.delete(id)
    void renderDelivery(d, id).catch(err => d.log(`delivery card: ${err}`))
  }, delay).unref?.()
}
export async function renderDelivery(d: Daemon, id: string): Promise<void> {
  const raw = d.store.get(id)
  if (!raw) return
  const r: Delivery = JSON.parse(raw)
  // Fast successful requests need no extra receipt message.
  if (!r.card && r.phase === 'done') return
  let locks = rendering.get(d)
  if (!locks) { locks = new Set(); rendering.set(d, locks) }
  if (locks.has(id)) { renderSoon(d, id, 200); return }
  locks.add(id)
  try { await inChat(d, r.chat.chatId, r.chat.threadId, async () => {
    const kb = new InlineKeyboard([[button(t('Проверить'), `ud:${r.chat.chatId}:${r.messageId}`)]])
    if (r.session) kb.row().text(t('Открыть текущую сессию'), `sm:s:${r.session}`)
    const text = `${t(LABEL[r.phase])} · #${r.messageId}`
    if (r.card) await d.bot.api.editMessageText(r.chat.chatId, r.card, text, { reply_markup: kb })
    else {
      const msg = await d.bot.api.sendMessage(r.chat.chatId, text, { message_thread_id: r.chat.threadId, disable_notification: true, reply_parameters: { message_id: Number(r.messageId), allow_sending_without_reply: true }, reply_markup: kb })
      // Do not overwrite a phase that advanced while the API request was in flight.
      const current: Delivery = JSON.parse(d.store.get(id) ?? raw)
      current.card = msg.message_id; d.store.set(id, JSON.stringify(current))
      if (current.phase !== r.phase) renderSoon(d, id, 100)
    }
  }) } finally { locks.delete(id) }
}

export type Alias = { projectKey: string; cwd: string; user?: string; topic?: { chatId: string; threadId: number; name: string } | null }
export function rememberSession(d: Daemon, s: Session): void {
  d.store.set(`ux:alias:${s.id}`, JSON.stringify({ projectKey: s.projectKey, cwd: s.cwd, user: d.userIdOf(s) ?? undefined, topic: s.topic } satisfies Alias))
  for (const key of d.store.keys('ux:active:')) {
    const oldId = key.slice('ux:active:'.length)
    if (oldId === s.id || d.sessions.has(oldId)) continue
    const raw = d.store.get(`ux:alias:${oldId}`)
    const a: Alias | null = raw ? JSON.parse(raw) : null
    if (a?.projectKey === s.projectKey && a.cwd === s.cwd) {
      const previous = JSON.parse(d.store.get(key) ?? '[]')
      const current = JSON.parse(d.store.get(`ux:active:${s.id}`) ?? '[]')
      d.store.set(`ux:active:${s.id}`, JSON.stringify([...previous, ...current].slice(-100)))
      d.store.set(key, null)
    }
  }
}
export function replacementSession(d: Daemon, id: string): Session | null {
  const raw = d.store.get(`ux:alias:${id}`)
  if (!raw) return null
  const a: Alias = JSON.parse(raw)
  return d.activeSessions().find(s => s.projectKey === a.projectKey && s.cwd === a.cwd) ?? null
}

export type ResultDetails = { summary?: string; checks?: string; remaining?: string; pr_url?: string }
export type Result = { id: string; session: string; project: string; chat: ChatRef; messages: number[]; card?: number; files: number[]; summary: string; checks?: string; remaining?: string; pr?: string; unread: boolean; at: number }
export function lastResult(d: Daemon, project: string): Result | null {
  const id = d.store.get(`ux:last-result:${project}`)
  return id ? JSON.parse(d.store.get(`ux:result:${id}`) ?? 'null') : null
}
export async function publishResult(d: Daemon, s: Session, chat: ChatRef, messages: number[], text: string, details?: ResultDetails): Promise<void> {
  if (process.env.RESULT_CARDS === 'off' || !messages.length || !details && text.length < 400 && !text.includes('github.com/') && !d.store.history(chat.chatId, chat.threadId ?? null, 5).some(m => messages.includes(m.message_id) && m.kind === 'document')) return
  const id = randomBytes(8).toString('hex')
  const clean = (x: unknown, n: number) => clip(maskSecrets(typeof x === 'string' ? x : ''), n)
  const pr = typeof details?.pr_url === 'string' ? details.pr_url : text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0]
  const r: Result = { id, session: s.id, project: s.projectKey, chat, messages: [...new Set(messages)], files: messages.filter(id => d.store.getMessage(chat.chatId, id)?.kind === 'document'), summary: clean(details?.summary || text || t('Получить файлы'), 500), ...(details?.checks ? { checks: clean(details.checks, 500) } : {}), ...(details?.remaining ? { remaining: clean(details.remaining, 500) } : {}), ...(pr && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr) ? { pr } : {}), unread: true, at: Date.now() }
  d.store.set(`ux:result:${id}`, JSON.stringify(r))
  d.store.set(`ux:last-result:${s.projectKey}`, id)
  const posted = await inChat(d, chat.chatId, chat.threadId, () => d.bot.api.sendMessage(chat.chatId, resultText(r, false), { parse_mode: 'HTML', disable_notification: true, message_thread_id: chat.threadId, reply_markup: resultButtons(r) }))
  const current: Result = JSON.parse(d.store.get(`ux:result:${id}`)!)
  current.card = posted.message_id
  d.store.set(`ux:result:${id}`, JSON.stringify(current))
}
export function resultText(r: Result, details: boolean): string {
  return [`<b>${t('Результат')}</b>`, escapeHtml(clip(r.summary, details ? 500 : 200)), ...(r.checks ? [`<b>${t('Проверено')}</b>: ${escapeHtml(clip(r.checks, details ? 500 : 160))}`] : []), ...(r.remaining ? [`<b>${t('Осталось')}</b>: ${escapeHtml(clip(r.remaining, details ? 500 : 160))}`] : [])].join('\n\n')
}
function resultButtons(r: Result): InlineKeyboard {
  const kb = new InlineKeyboard([[button(t('Подробности'), `urx:show:${r.id}`), button(t('Повторить всё'), `urx:repeat:${r.id}`)], [button(t('Отметить прочитанным'), `urx:read:${r.id}`)]])
  if (r.files?.length) kb.row().text(t('Получить файлы'), `urx:files:${r.id}`)
  if (r.pr) kb.row().url('PR', r.pr)
  return kb
}
export async function handleUxCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const delivery = /^ud:(-?\d+):(\d+)$/.exec(data)
  const result = /^urx:(show|repeat|read|files):([0-9a-f]+)$/.exec(data)
  if (!delivery && !result) return false
  if (!ctx.from || !can(ctx.from.id, 'answer')) { await ctx.answerCallbackQuery({ text: t('Нет доступа.') }); return true }
  const message = ctx.callbackQuery?.message
  if (delivery) {
    const raw = d.store.get(key(delivery[1], delivery[2]))
    const r: Delivery | null = raw ? JSON.parse(raw) : null
    if (!r || !message || String(message.chat.id) !== r.chat.chatId || !can(ctx.from.id, 'control') && String(ctx.from.id) !== r.userId) { await ctx.answerCallbackQuery({ text: t('Нет доступа.') }); return true }
    await ctx.answerCallbackQuery({ text: t(LABEL[r.phase]) })
    await renderDelivery(d, r.id)
    return true
  }
  const r: Result | null = JSON.parse(d.store.get(`ux:result:${result![2]}`) ?? 'null')
  const thread = message && 'message_thread_id' in message ? message.message_thread_id : undefined
  if (!r || !message || String(message.chat.id) !== r.chat.chatId || (thread ?? 0) !== (r.chat.threadId ?? 0)) { await ctx.answerCallbackQuery({ text: t('Нет доступа.') }); return true }
  await ctx.answerCallbackQuery()
  if (result![1] === 'repeat' || result![1] === 'files') {
    // Copy every original part/attachment, in order; no files are re-read from arbitrary paths.
    for (const id of result![1] === 'files' ? r.files ?? [] : r.messages) {
      try { await d.bot.api.copyMessage(r.chat.chatId, r.chat.chatId, id, { message_thread_id: r.chat.threadId }) }
      catch (err) { d.log(`result replay: ${err}`); await ctx.reply(t('Не доставлено'), { message_thread_id: r.chat.threadId }).catch(() => {}); return true }
    }
  } else if (result![1] === 'show') await ctx.editMessageText(resultText(r, true), { parse_mode: 'HTML', reply_markup: resultButtons(r) })
  r.unread = false; d.store.set(`ux:result:${r.id}`, JSON.stringify(r))
  return true
}

/** UI payloads have bounded retention; lightweight session aliases keep old navigation working. */
export function startUx(d: Daemon): void {
  const prune = () => {
    const cutoff = Date.now() - 30 * 86400_000
    for (const prefix of ['ux:delivery:', 'ux:result:']) for (const key of d.store.keys(prefix)) {
      try {
        const r = JSON.parse(d.store.get(key)!)
        if ((r.updated ?? r.at) < cutoff) d.store.set(key, null)
      } catch { d.log(`invalid UI record: ${key}`) }
    }
  }
  prune()
  setInterval(prune, 86400_000).unref?.()
}
