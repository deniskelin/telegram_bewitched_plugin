/**
 * Bot construction and Bot API 10.x calls that the bundled grammY types don't
 * know yet (rich messages, rich drafts, can_stop). Those go through
 * `bot.api.raw`, which forwards any method name to Telegram.
 */

import { Bot, GrammyError } from 'grammy'
import { escapeHtml } from './format.ts'

export type ThreadOpt = { message_thread_id?: number }

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
  return bot
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
 * Stream a draft into a private chat. Prefers sendRichMessageDraft with a
 * <tg-thinking> block (Bot API 10.2); falls back to plain sendMessageDraft.
 */
export async function sendDraft(bot: Bot, chatId: number, draftId: number, c: DraftContent, opt: ThreadOpt = {}): Promise<void> {
  const stop = c.canStop ? { can_stop: true } : {}
  if (c.thinking && !isUnsupported('sendRichMessageDraft')) {
    const html = `<tg-thinking>${escapeHtml(c.thinking)}</tg-thinking>` + (c.body ? `\n${escapeHtml(c.body)}` : '')
    try {
      await raw(bot).sendRichMessageDraft({ chat_id: chatId, draft_id: draftId, rich_message: { html }, ...opt, ...stop })
      return
    } catch (err) {
      noteFailure('sendRichMessageDraft', err)
    }
  }
  const text = [c.thinking, c.body].filter(Boolean).join('\n\n').slice(-4000)
  await raw(bot).sendMessageDraft({ chat_id: chatId, draft_id: draftId, text, ...opt, ...stop })
}

/** Rich message from Markdown (Bot API 10.1+). Returns the message id. */
export async function sendRich(bot: Bot, chatId: string, markdown: string, extra: Record<string, unknown> = {}): Promise<number> {
  const res = await raw(bot).sendRichMessage({ chat_id: chatId, rich_message: { markdown }, ...extra })
  return res.message_id as number
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
