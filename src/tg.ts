/**
 * Bot construction and Bot API 10.x calls that the bundled grammY types don't
 * know yet (rich messages, rich drafts, can_stop). Those go through
 * `bot.api.raw`, which forwards any method name to Telegram.
 */

import { Bot, GrammyError } from 'grammy'
import { escapeHtml } from './format.ts'
import { hardBreaks, liveTimes, screenToRich } from './rich.ts'
import { BUTTON_EMOJI } from './daemon/button-emoji.ts'

export type ThreadOpt = { message_thread_id?: number }

/** Custom icon → the emoji it stands for (the first label emoji mapped to it; the agents' robot). */
// Symbols that are text by default get U+FE0F back, so they show as emoji (⚙️, not ⚙).
const asEmoji = (e: string) => ('⚠♻↩▶⚙➡⬆✏✖✍✉✈'.includes(e) ? `${e}\uFE0F` : e)
const ICON_FALLBACK = new Map<string, string>([...Object.entries(BUTTON_EMOJI).map(([e, id]) => [id, asEmoji(e)] as [string, string]).reverse(), ['5255760585445901285', '🤖'], ['5256261335682941418', '🤖']])

/** F06: custom button icons in use; off once Telegram refused them, or with BUTTON_ICONS=off. */
export const buttonIcons = { on: process.env.BUTTON_ICONS !== 'off' }

/** The keyboard with each custom icon put back as its plain emoji at the start of the label. */
export function withoutIcons(p: Record<string, unknown>): Record<string, unknown> {
  const kb = p.reply_markup as { inline_keyboard?: Record<string, unknown>[][] } | undefined
  if (!kb?.inline_keyboard) return p
  const rows = kb.inline_keyboard.map(row => row.map(b => {
    const id = b.icon_custom_emoji_id
    if (typeof id !== 'string') return b
    const { icon_custom_emoji_id: _, ...rest } = b
    const e = ICON_FALLBACK.get(id)
    const text = String(b.text ?? '')
    return { ...rest, text: e ? (text.startsWith('• ') ? `• ${e} ${text.slice(2)}` : `${e} ${text}`) : text }
  }))
  return { ...p, reply_markup: { ...kb, inline_keyboard: rows } }
}

export function createBot(token: string, apiRoot?: string): Bot {
  const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : undefined)
  // Global 429 handling: wait retry_after and retry (up to 3 times). Every
  // outbound call from every session funnels through this one Bot instance.
  bot.api.config.use(async (prev, method, payload, signal) => {
    for (let attempt = 0; ; attempt++) {
      const res = await prev(method, payload, signal)
      const retry = (res as { ok: boolean; error_code?: number; parameters?: { retry_after?: number } })
      if (res.ok || retry.error_code !== 429 || attempt >= 3) return res
      const wait = Math.min((retry.parameters?.retry_after ?? 1) * 1000, 30_000)
      await new Promise(r => setTimeout(r, wait))
    }
  })
  // F06: custom button icons need the bot owner's Premium (or a Fragment username). A call Telegram refuses
  // while its keyboard carries them goes again with plain emoji in the labels, and icons stay off until restart.
  bot.api.config.use(async (prev, method, payload, signal) => {
    const p = payload as Record<string, unknown>
    const hasIcons = p.reply_markup != null && JSON.stringify(p.reply_markup).includes('icon_custom_emoji_id')
    if (hasIcons && !buttonIcons.on) return prev(method, withoutIcons(p) as typeof payload, signal)
    const res = await prev(method, payload, signal)
    const err = res as { ok: boolean; error_code?: number; description?: string }
    if (res.ok || !hasIcons || err.error_code !== 400 || /not modified|thread not found|TOPIC_|message to edit not found/i.test(err.description ?? '')) return res
    const again = await prev(method, withoutIcons(p) as typeof payload, signal)
    if (again.ok) {
      buttonIcons.on = false
      console.error(`custom button icons refused (${err.description}): plain emoji from now on`)
    }
    return again
  })
  bot.api.config.use(async (prev, method, payload, signal) => {
    const rich = richScreenCall(method, payload as Record<string, unknown>)
    // Live-time markers (liveTime) never reach Telegram as they are: rich gets <tg-time>, the rest the plain text.
    const p = payload as Record<string, unknown>
    if (typeof p.text === 'string' && p.text.includes('\u2063')) payload = { ...p, text: liveTimes(p.text, false) } as typeof payload
    const key = method === 'sendMessage' ? 'sendRichMessage' : 'editMessageText:rich'
    if (!rich) return prev(method, payload, signal)
    const res = await prev(rich.method as typeof method, rich.payload as typeof payload, signal)
    const err = res as { ok: boolean; error_code?: number; description?: string }
    // Not modified / no topic / flood are the same for the HTML text; anything else — send it as before.
    if (res.ok || /not modified|thread not found|TOPIC_|Too Many/i.test(err.description ?? '')) return res
    if (err.error_code === 404 || /method not found|unknown method/i.test(err.description ?? '')) unsupported.set(key, Date.now())
    console.error(`rich screen failed, sending HTML: ${err.description}`)
    return prev(method, payload, signal)
  })
  return bot
}

/**
 * FR-11: a screen of the daemon (an HTML message whose first line is a title,
 * "🎛 <b>Меню</b>") goes as a rich message — heading, divider, sections. The
 * call sites keep sending HTML; this turns it into sendRichMessage /
 * editMessageText with rich_message, and the HTML is the fallback.
 */
function richScreenCall(method: string, p: Record<string, unknown>): { method: string; payload: Record<string, unknown> } | null {
  if ((method !== 'sendMessage' && method !== 'editMessageText') || p.parse_mode !== 'HTML' || typeof p.text !== 'string') return null
  if (process.env.RICH_SCREENS === 'off') return null
  if (isUnsupported(method === 'sendMessage' ? 'sendRichMessage' : 'editMessageText:rich')) return null
  const html = screenToRich(p.text)
  if (!html) return null
  return finishRich(method, p, liveTimes(html, true))
}

function finishRich(method: string, p: Record<string, unknown>, html: string): { method: string; payload: Record<string, unknown> } {
  const { text: _t, parse_mode: _p, link_preview_options: _l, entities: _e, ...rest } = p
  return { method: method === 'sendMessage' ? 'sendRichMessage' : method, payload: { ...rest, rich_message: { html } } }
}

// biome-ignore lint: raw is a proxy over arbitrary method names
type Raw = Record<string, (payload: Record<string, unknown>) => Promise<any>>

function raw(bot: Bot): Raw {
  return bot.api.raw as unknown as Raw
}

/** Methods that failed with "method not found" are not retried for an hour. */
const unsupported = new Map<string, number>()

function isUnsupported(method: string): boolean {
  const t = unsupported.get(method)
  return t != null && Date.now() - t < 3600_000
}

function noteFailure(method: string, err: unknown): void {
  if (err instanceof GrammyError && (err.error_code === 404 || /method not found|unknown method/i.test(err.description))) {
    unsupported.set(method, Date.now())
  }
}

export type DraftContent = {
  /** Shown in the native "thinking" block (rich drafts only). */
  thinking?: string
  /** Main draft body. Empty → Telegram's "Thinking…" placeholder. */
  body?: string
  canStop?: boolean
}

/**
 * Stream a draft into a private chat. Prefers sendRichMessageDraft — the body
 * is the model's Markdown, the steps go in a <tg-thinking> block (Bot API
 * 10.2); falls back to plain sendMessageDraft.
 */
export async function sendDraft(bot: Bot, chatId: number, draftId: number, c: DraftContent, opt: ThreadOpt = {}): Promise<void> {
  const stop = c.canStop ? { can_stop: true } : {}
  if ((c.thinking || c.body) && !isUnsupported('sendRichMessageDraft')) {
    const markdown = (c.thinking ? `<tg-thinking>${escapeHtml(c.thinking)}</tg-thinking>\n\n` : '') + (c.body ? hardBreaks(c.body) : '')
    try {
      await raw(bot).sendRichMessageDraft({ chat_id: chatId, draft_id: draftId, rich_message: { markdown }, ...opt, ...stop })
      return
    } catch (err) {
      noteFailure('sendRichMessageDraft', err)
    }
  }
  const text = [c.thinking, c.body].filter(Boolean).join('\n\n').slice(-4000)
  await raw(bot).sendMessageDraft({ chat_id: chatId, draft_id: draftId, text, ...opt, ...stop })
}

/** Rich message from Markdown (Bot API 10.1+). Returns the message id. */
export async function sendRich(bot: Bot, chatId: string, content: string | { html: string }, extra: Record<string, unknown> = {}): Promise<number> {
  const rich_message = typeof content === 'string' ? { markdown: liveTimes(hardBreaks(content), true) } : { html: liveTimes(content.html, true) }
  const res = await raw(bot).sendRichMessage({ chat_id: chatId, rich_message, ...extra })
  return res.message_id as number
}

/** An existing message (text or rich) becomes this rich Markdown, or rich HTML. */
export async function editRich(bot: Bot, chatId: string, messageId: number, content: string | { html: string }, extra: Record<string, unknown> = {}): Promise<void> {
  const rich_message = typeof content === 'string' ? { markdown: liveTimes(hardBreaks(content), true) } : { html: liveTimes(content.html, true) }
  await raw(bot).editMessageText({ chat_id: chatId, message_id: messageId, rich_message, ...extra })
}

export function isThreadNotFound(err: unknown): boolean {
  return err instanceof GrammyError && /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(err.description)
}

export function isMessageNotModified(err: unknown): boolean {
  return err instanceof GrammyError && /message is not modified/i.test(err.description)
}

/** t.me link to a forum topic. Supergroup ids look like -100XXXXXXXXXX. */
export function topicLink(chatId: string, threadId: number): string | null {
  const m = /^-100(\d+)$/.exec(chatId)
  return m ? `https://t.me/c/${m[1]}/${threadId}` : null
}
