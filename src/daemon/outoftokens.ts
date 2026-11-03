/**
 * Out of tokens: a turn failed on the subscription's usage limit, an API rate
 * limit or an empty API balance. The model can't answer until then, but the
 * daemon can: it holds every new message, tells the sender in their language
 * when the answer will come, and at the reset hands the held messages to their
 * sessions in one batch ("while there were no tokens, this arrived").
 *
 * Limits are per account, so the pause is one for the whole daemon.
 */

import { InlineKeyboard, type Context } from 'grammy'
import { can } from '../access.ts'
import type { ChatRef, Daemon, Session } from './daemon.ts'
import { inChat } from './lang.ts'
import { button } from './stream.ts'
import { fetchLimits, resetLimitsCache } from './usage.ts'
import { codex, projectEngine, setProjectEngine, type EngineId } from './engines.ts'
import { locale, t as tr } from '../i18n/index.ts'

export type PauseKind = 'subscription' | 'rate' | 'billing'
export type Pause = { kind: PauseKind; until: number | null; at: number; tries: number }
type Held = { projectKey: string; content: string; meta: Record<string, string>; from: ChatRef }

const STATE = 'tokens_pause'
const HELD = 'tokens_held'
/** Sessions whose turn broke on the limit: told to finish it at the reset. */
const BROKEN = 'tokens_broken'
/** Rate limits without a stated time: try again after this, doubling up to the cap. */
const RATE_RETRY_MS = 2 * 60_000
const RATE_RETRY_MAX_MS = 30 * 60_000

let timer: ReturnType<typeof setTimeout> | null = null

const read = <T>(d: Daemon, key: string, empty: T): T => {
  try {
    return JSON.parse(d.store.get(key) ?? '') as T
  } catch {
    return empty
  }
}

export function pauseOf(d: Daemon): Pause | null {
  return read<Pause | null>(d, STATE, null)
}

/** What kind of limit the failed turn hit, from the StopFailure error type and Claude Code's message. */
export function classify(error: string, text: string): PauseKind | null {
  if (error === 'billing_error' || /credit balance|billing|insufficient.{0,20}(funds|credit)|payment/i.test(text)) return 'billing'
  if (/usage limit|hit your .{0,20}limit|limit reached|out of (extra )?usage|resets? (at )?\d/i.test(text)) return 'subscription'
  if (error === 'rate_limit' || /\b429\b|rate.?limit/i.test(text)) return 'rate'
  return null
}

/** "resets 2:20pm", "resets 14:20", "limit reached|1761748800" → the time; null when the message has none. */
export function parseReset(text: string, now = Date.now()): number | null {
  const epoch = /\|(\d{10})\b/.exec(text)
  if (epoch) return Number(epoch[1]) * 1000
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(text)
  if (!m) return null
  let h = Number(m[1]) % 24
  const min = Number(m[2] ?? 0)
  if (m[3]) h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0)
  // "(Europe/Moscow)": the time is on that clock, not the server's.
  const shift = m[4] ? zoneOffset(m[4], now) : null
  const d = new Date(now + (shift ?? 0))
  if (shift != null) d.setUTCHours(h, min, 0, 0)
  else d.setHours(h, min, 0, 0)
  let at = d.getTime() - (shift ?? 0)
  if (at <= now) at += 24 * 3600_000
  return at
}

/** Milliseconds the zone's clock is ahead of UTC at that moment; null for an unknown zone. */
function zoneOffset(zone: string, at: number): number | null {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(at)).map(x => [x.type, Number(x.value)]))
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000
  } catch {
    return null
  }
}

/**
 * The subscription's own answer is better than the text: the latest reset
 * among the windows that are full (5 hours and the week can both be).
 */
async function subscriptionReset(): Promise<number | null> {
  resetLimitsCache()
  const limits = await fetchLimits()
  if (typeof limits === 'string') return null
  const full = limits.items.filter(l => l.percent >= 100 && l.resetsAt).map(l => l.resetsAt!.getTime())
  return full.length ? Math.max(...full) : null
}

/** StopFailure of a turn: true when it was a limit and the pause is on (the caller skips its generic notice). */
export async function onLimitFailure(d: Daemon, s: Session, error: string, text: string): Promise<boolean> {
  const kind = classify(error, text)
  if (!kind) return false
  const now = Date.now()
  const prev = pauseOf(d)
  let until: number | null = null
  if (kind === 'subscription') until = (await subscriptionReset()) ?? parseReset(text, now)
  else if (kind === 'rate') {
    const tries = prev?.kind === 'rate' ? prev.tries + 1 : 0
    until = parseReset(text, now) ?? now + Math.min(RATE_RETRY_MS * 2 ** tries, RATE_RETRY_MAX_MS)
  }
  const pause: Pause = { kind, until, at: prev?.at ?? now, tries: prev?.kind === kind ? prev.tries + 1 : 0 }
  d.store.set(STATE, JSON.stringify(pause))
  const broken = new Set(read<string[]>(d, BROKEN, []))
  broken.add(s.projectKey)
  d.store.set(BROKEN, JSON.stringify([...broken]))
  d.log(`out of tokens (${kind}), until ${until ? new Date(until).toISOString() : '?'}`)
  schedule(d)
  const chat = s.lastChat
  if (chat) await say(d, chat, pause, undefined, true, undefined, canFallBack(s) ? s : undefined)
  return true
}

/** Deliver or hold: true when the message was held (Daemon.deliver stops there). */
export function holdIfPaused(d: Daemon, s: Session, content: string, meta: Record<string, string>, from: ChatRef): boolean {
  const pause = pauseOf(d)
  if (!pause) return false
  // The pause is Claude's subscription: a Codex session has its own limits and takes the message now.
  if (s.engine !== 'claude') {
    d.log(`out of tokens: message for ${s.engine} session ${s.id} not held (the pause is Claude's)`)
    return false
  }
  // The time passed while the daemon was down, or the timer is late: release first.
  if (pause.until && pause.until <= Date.now()) {
    void release(d)
    return false
  }
  const held = read<Held[]>(d, HELD, [])
  held.push({ projectKey: s.projectKey, content, meta, from })
  d.store.set(HELD, JSON.stringify(held.slice(-200)))
  d.log(`out of tokens: message for session ${s.id} held (${held.length} waiting)`)
  const replyTo = Number(meta.message_id) || undefined
  // A voice message: show what was heard, so the sender knows it was saved right.
  void say(d, from, pause, replyTo, false, meta.voice_transcribed === 'true' ? content : undefined)
  return true
}

function when(until: number): string {
  const d = new Date(until)
  const sameDay = d.toDateString() === new Date().toDateString()
  return d.toLocaleString(locale(), sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** The text for the sender; first: the turn just failed (no message of theirs was held yet). */
export function pauseText(p: Pause, first: boolean): string {
  const t = p.until ? when(p.until) : ''
  const lead = {
    subscription: tr('⏸ Закончились токены подписки Claude.'),
    rate: tr('⏸ Превышен лимит запросов к API Anthropic.'),
    billing: tr('⏸ На балансе API Anthropic закончились средства.'),
  }[p.kind]
  const after = p.kind === 'billing'
    ? tr('Отвечу, когда баланс пополнят и владелец нажмёт «▶️ Продолжить сейчас».')
    : p.kind === 'rate'
      ? tr('Попробую снова около {time}.', { time: t })
      : t ? tr('Отвечу сразу после сброса лимита в {time}.', { time: t }) : tr('Отвечу сразу после сброса лимита.')
  return first
    ? tr('{lead} Ход прервался — договорю его, когда лимит восстановится. Новые сообщения запишу. {after}', { lead, after })
    : tr('{lead} Сообщение записал. {after}', { lead, after })
}

function resumeKb(fallback?: Session): InlineKeyboard {
  const rows = [[button(tr('▶️ Продолжить сейчас'), 'tok:go')]]
  // FR-18: the work goes on on Codex until the reset, with the handoff; only the owner can press it.
  if (fallback) rows.unshift([button(tr('🔀 Продолжить на Codex до сброса'), `tok:cx:${fallback.id}`, 'primary')])
  return new InlineKeyboard(rows)
}

/** A Claude session that may fall back to Codex: Codex is installed. */
function canFallBack(s: Session): boolean {
  return s.engine === 'claude' && codex.available()
}

async function say(d: Daemon, chat: ChatRef, p: Pause, replyTo: number | undefined, first: boolean, heard?: string, fallback?: Session): Promise<void> {
  await inChat(d, chat.chatId, chat.threadId, async () => {
    const text = heard ? `${pauseText(p, first)}\n\n${heard.length > 3000 ? heard.slice(0, 2999) + '…' : heard}` : pauseText(p, first)
    await d.bot.api.sendMessage(chat.chatId, text, {
      ...(chat.threadId != null ? { message_thread_id: chat.threadId } : {}),
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      // Only the owner may lift the pause by hand; others see the same button but get "no access".
      reply_markup: resumeKb(fallback),
    }).catch(err => d.log(`out-of-tokens notice failed: ${err}`))
  })
}

function schedule(d: Daemon): void {
  if (timer) clearTimeout(timer)
  timer = null
  const p = pauseOf(d)
  if (!p?.until) return
  // Half a minute after the reset: the limit counts the new window by then.
  timer = setTimeout(() => void release(d), Math.max(0, p.until + 30_000 - Date.now()))
  timer.unref?.()
}

/** The limit is back: lift the pause and give each session what came for it. */
export async function release(d: Daemon): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  if (!pauseOf(d)) return
  const held = read<Held[]>(d, HELD, [])
  const broken = read<string[]>(d, BROKEN, [])
  d.store.set(STATE, null)
  d.store.set(HELD, null)
  d.store.set(BROKEN, null)
  d.log(`tokens back: ${held.length} held message(s), ${broken.length} broken turn(s)`)
  const byProject = new Map<string, Held[]>()
  for (const h of held) byProject.set(h.projectKey, [...(byProject.get(h.projectKey) ?? []), h])
  for (const key of broken) if (!byProject.has(key)) byProject.set(key, [])
  const told = new Set<string>()
  for (const [key, items] of byProject) {
    const s = d.sessionForProject(key)
    // The project moved to another engine meanwhile: Claude's broken turn is not its business.
    const brokenHere = broken.includes(key) && (!s || s.engine === 'claude')
    if (s && s.engine !== 'claude' && broken.includes(key)) d.log(`tokens back: broken turn of ${key} dropped, its session ${s.id} now runs ${s.engine}`)
    if (s && s.engine !== 'claude' && !items.length) continue
    const note = brokenHere
      ? 'Лимит токенов восстановился. Твой предыдущий ход прервался из-за лимита — доведи его до конца.' // i18n-ignore
      : 'Лимит токенов восстановился.' // i18n-ignore
    if (!s) {
      // The session is gone: route again — that queues for its next start or launches it.
      for (const h of items) await d.routeText(h.from, h.meta.user_id ?? '', h.content, h.meta).catch(err => d.log(`held route failed: ${err}`))
      continue
    }
    await handOver(d, s, items, note, told)
  }
  await offerReturn(d)
}

/** Messages held for a project, or the note about its broken turn, to its session now; each chat is told once. */
async function handOver(d: Daemon, s: Session, items: Held[], note: string, told: Set<string>, chatNote = (n: number) => tr('▶️ Лимит восстановился — отвечаю на записанное ({n}).', { n })): Promise<void> {
  if (!items.length) {
    if (s.lastChat) d.deliver(s, note, { event: 'tokens_back', chat_id: s.lastChat.chatId }, s.lastChat)
    return
  }
  const last = items.at(-1)!
  const content = items.length === 1
    ? `[${note} Пока токенов не было, пришло это сообщение — ответь на него.]\n\n${last.content}` // i18n-ignore
    : `[${note} Пока токенов не было, пришло сообщений: ${items.length}. Ответь на каждое (chat_id и message_id в скобках).]\n\n` // i18n-ignore
      + items.map(h => `(${h.meta.user ?? ''}; chat_id=${h.from.chatId}${h.from.threadId != null ? `, message_thread_id=${h.from.threadId}` : ''}; message_id=${h.meta.message_id ?? ''}) ${h.content}`).join('\n\n')
  for (const h of items) {
    const k = `${h.from.chatId}:${h.from.threadId ?? ''}`
    if (told.has(k)) continue
    told.add(k)
    const n = items.filter(x => x.from.chatId === h.from.chatId && x.from.threadId === h.from.threadId).length
    await inChat(d, h.from.chatId, h.from.threadId, () => d.bot.api.sendMessage(h.from.chatId, chatNote(n), {
      ...(h.from.threadId != null ? { message_thread_id: h.from.threadId } : {}),
      disable_notification: true,
    })).catch(() => {})
  }
  d.deliver(s, content, items.length === 1 ? last.meta : { ...last.meta, held_count: String(items.length) }, last.from)
}

// --------------------------------------------------------------------------
// FR-18: on Codex until the reset
// --------------------------------------------------------------------------

/** A project moved to Codex for the pause: the engine and model to go back to. */
type Fallback = { engine: EngineId; model?: string; at: number }
const fallbackKey = (project: string) => `fallback:${project}`

export function fallbackOf(d: Daemon, project: string): Fallback | null {
  return read<Fallback | null>(d, fallbackKey(project), null)
}

/** The held messages and the broken turn of one project: taken out of the pause, for its new session. */
function takeHeld(d: Daemon, project: string): { items: Held[]; broken: boolean } {
  const held = read<Held[]>(d, HELD, [])
  const broken = read<string[]>(d, BROKEN, [])
  d.store.set(HELD, JSON.stringify(held.filter(h => h.projectKey !== project)))
  d.store.set(BROKEN, JSON.stringify(broken.filter(k => k !== project)))
  return { items: held.filter(h => h.projectKey === project), broken: broken.includes(project) }
}

/** tok:cx:<session> — the session goes on on Codex with the handoff; the held messages follow it. */
async function fallBackToCodex(d: Daemon, ctx: Context, s: Session): Promise<void> {
  const prev = projectEngine(d, s.projectKey)
  d.store.set(fallbackKey(s.projectKey), JSON.stringify({ engine: prev.engine, model: prev.model ?? undefined, at: Date.now() } satisfies Fallback))
  setProjectEngine(d, s.projectKey, { engine: 'codex' })
  const p = pauseOf(d)
  // i18n-ignore-start: for the model
  const note = `У Claude закончился лимит${p?.until ? ` (сброс в ${when(p.until)})` : ''}, работа переходит к тебе до сброса. Если прежний ход прервался на середине — доведи его до конца.`
  // i18n-ignore-end
  const { switchSession } = await import('./menu.ts')
  const edit = (sc: { text: string; kb: InlineKeyboard }) => ctx.editMessageText(sc.text, { parse_mode: 'HTML', reply_markup: sc.kb }).then(() => {}).catch(() => {})
  d.log(`FR-18: session ${s.id} (${s.projectKey}) falls back to Codex until the reset`)
  await switchSession(d, s, edit, {
    note,
    after: async n => {
      const { items } = takeHeld(d, s.projectKey)
      if (items.length) await handOver(d, n, items, 'Лимит Claude кончился, отвечает Codex.', new Set(), k => tr('🔀 Отвечает Codex — записанное ({n}).', { n: k })) // i18n-ignore
    },
  })
}

/** The pause is over: projects moved to Codex for it are offered the way back (not forced: a turn may be running). */
async function offerReturn(d: Daemon): Promise<void> {
  for (const s of d.activeSessions()) {
    const f = fallbackOf(d, s.projectKey)
    if (!f || s.engine !== 'codex') continue
    const c = s.lastChat
    if (!c) continue
    await inChat(d, c.chatId, c.threadId, () => d.bot.api.sendMessage(c.chatId, tr('▶️ Лимит Claude восстановился. Сессия #{id} пока на Codex — вернуть работу на Claude? Дела передам так же.', { id: s.id }), {
      ...(c.threadId != null ? { message_thread_id: c.threadId } : {}),
      reply_markup: new InlineKeyboard([[button(tr('↩️ Вернуть на Claude'), `tok:back:${s.id}`, 'primary'), button(tr('Остаться на Codex'), `tok:stay:${s.id}`)]]),
    })).catch(err => d.log(`fallback return offer failed: ${err}`))
  }
}

/** tok:back:<session> — back to the engine (and model) the project had before the pause, with the handoff. */
async function returnFromCodex(d: Daemon, ctx: Context, s: Session): Promise<void> {
  const f = fallbackOf(d, s.projectKey)
  d.store.set(fallbackKey(s.projectKey), null)
  setProjectEngine(d, s.projectKey, { engine: f?.engine ?? 'claude', ...(f?.model ? { model: f.model } : {}) })
  const { switchSession } = await import('./menu.ts')
  const edit = (sc: { text: string; kb: InlineKeyboard }) => ctx.editMessageText(sc.text, { parse_mode: 'HTML', reply_markup: sc.kb }).then(() => {}).catch(() => {})
  d.log(`FR-18: session ${s.id} (${s.projectKey}) returns to ${f?.engine ?? 'claude'}`)
  await switchSession(d, s, edit, { note: 'Лимит Claude восстановился: работа возвращается к тебе после Codex.' }) // i18n-ignore
}

/** tok:go — the owner lifts the pause now (balance topped up, or the time was guessed wrong); tok:cx|back|stay:<session> — FR-18. */
export async function handleTokensCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const fb = /^tok:(cx|back|stay):([0-9a-f]+)$/.exec(data)
  if (data !== 'tok:go' && !fb) return false
  if (!ctx.from || !can(ctx.from.id, 'control')) {
    await ctx.answerCallbackQuery({ text: tr('Нет доступа.') }).catch(() => {})
    return true
  }
  if (fb) {
    const s = d.sessions.get(fb[2])
    if (!s) { await ctx.answerCallbackQuery({ text: tr('Сессия уже отключилась.') }).catch(() => {}); return true }
    if (fb[1] === 'stay') {
      d.store.set(fallbackKey(s.projectKey), null)
      await ctx.answerCallbackQuery({ text: tr('Остаётся на Codex') }).catch(() => {})
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
      return true
    }
    if (fb[1] === 'cx' && s.engine !== 'claude') { await ctx.answerCallbackQuery({ text: tr('Сессия уже на Codex.') }).catch(() => {}); return true }
    if (fb[1] === 'back' && s.engine !== 'codex') { await ctx.answerCallbackQuery({ text: tr('Сессия уже не на Codex.') }).catch(() => {}); return true }
    await ctx.answerCallbackQuery({ text: fb[1] === 'cx' ? tr('🔀 Переключаю на Codex…') : tr('↩️ Возвращаю на Claude…') }).catch(() => {})
    void (fb[1] === 'cx' ? fallBackToCodex(d, ctx, s) : returnFromCodex(d, ctx, s)).catch(err => d.log(`FR-18 switch failed: ${err}`))
    return true
  }
  const was = pauseOf(d)
  await ctx.answerCallbackQuery({ text: was ? tr('▶️ Продолжаю') : tr('Пауза уже снята.') }).catch(() => {})
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
  if (was) await release(d)
  return true
}

/** After a restart: the timer for a pause that is still on. */
export function startTokensWatch(d: Daemon): void {
  schedule(d)
}

/** Short status for the owner's /menu, e.g. "⏸ лимит до 14:20". */
export function pauseBadge(d: Daemon): string | null {
  const p = pauseOf(d)
  if (!p) return null
  return p.until ? tr('⏸ нет токенов до {time}', { time: when(p.until) }) : tr('⏸ нет токенов')
}

/** A friendlier line than Claude Code's English for the other ways a turn can fail. */
export function failureHint(error: string): string | null {
  switch (error) {
    case 'authentication_failed': return tr('Claude Code не авторизован: выполните /login в терминале сессии.')
    case 'server_error': return tr('Сервер Anthropic ответил ошибкой или перегружен — повторите сообщение чуть позже.')
    case 'max_output_tokens': return tr('Ответ упёрся в максимальную длину — попросите продолжить.')
    case 'invalid_request': return tr('Запрос отклонён API (слишком большой контекст или вложение?) — попробуйте /compact.')
    default: return null
  }
}
