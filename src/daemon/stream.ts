/**
 * Live progress while Claude works on a turn that came from Telegram.
 *
 * Two renderers:
 *  - private chat → native drafts (sendRichMessageDraft with a thinking block,
 *    fallback sendMessageDraft), refreshed before the 30 s draft lifetime ends;
 *  - groups/topics → one service message "⏳ Работаю…" edited in place, with a
 *    ⏹ stop button. Drafts don't exist outside private chats.
 *
 * Input comes from hooks (tool calls, MessageDisplay text) via the HTTP endpoint.
 */

import { InlineKeyboard } from 'grammy'
import { prefsFor, verboseBadge } from '../access.ts'
import { settings } from '../config.ts'
import { clip, fmtDuration, maskSecrets } from '../format.ts'
import { isMessageNotModified, sendDraft } from '../tg.ts'
import type { ChatRef, Daemon, Session } from './daemon.ts'
import { t } from '../i18n/index.ts'

const MAX_LINES = 12
const MAX_TEXT = 1500
/** The streamed answer may be longer: it becomes the reply. */
const MAX_ANSWER = 3500
const DRAFT_KEEPALIVE_MS = 20_000
const TYPING_MS = 4_000

type Stream = {
  chat: ChatRef
  startedAt: number
  draftId: number
  lines: string[]
  text: string
  /** Text since the last tool call: the answer as it is written. */
  answer: string
  progressMsgId: number | null
  dirty: boolean
  lastFlush: number
  flushTimer: ReturnType<typeof setTimeout> | null
  ticker: ReturnType<typeof setInterval> | null
  typing: ReturnType<typeof setInterval> | null
  closed: boolean
  opening: Promise<void> | null
}

export function stopKeyboard(sessionId: string): InlineKeyboard | undefined {
  return settings.stopMode === 'off' ? undefined : new InlineKeyboard([[button(t('⏹ Стоп'), `stop:${sessionId}`, 'danger')]])
}

export type ButtonStyle = 'primary' | 'success' | 'danger'

/** Callback button with Bot API 9.4 `style` (unknown to the bundled grammY types). */
export function button(text: string, data: string, style?: ButtonStyle, disabled = false) {
  return { text: clip(text, 64), callback_data: data, ...(style ? { style } : {}), ...(disabled ? { disabled: {} } : {}) } as { text: string; callback_data: string }
}

export class Streams {
  private map = new Map<string, Stream>()

  constructor(private d: Daemon) {}

  has(s: Session): boolean {
    return this.map.has(s.id)
  }

  open(s: Session, chat: ChatRef): void {
    const cur = this.map.get(s.id)
    if (cur && !cur.closed && cur.chat.chatId === chat.chatId && cur.chat.threadId === chat.threadId) return
    if (cur) this.close(s, 'replaced')
    const st: Stream = {
      chat,
      startedAt: Date.now(),
      draftId: 1 + Math.floor(Math.random() * 2_000_000_000),
      lines: [],
      text: '',
      answer: '',
      progressMsgId: null,
      dirty: false,
      lastFlush: 0,
      flushTimer: null,
      ticker: null,
      typing: null,
      closed: false,
      opening: null,
    }
    this.map.set(s.id, st)
    st.opening = this.start(s, st).catch(err => this.d.log(`stream open failed: ${err}`))
  }

  private async start(s: Session, st: Stream): Promise<void> {
    const { chatId, threadId, isPrivate } = st.chat
    const thread = threadId != null ? { message_thread_id: threadId } : {}
    if (isPrivate) {
      await sendDraft(this.d.bot, Number(chatId), st.draftId, { body: '', canStop: settings.stopMode !== 'off' }, thread)
      st.lastFlush = Date.now()
      st.ticker = setInterval(() => {
        if (Date.now() - st.lastFlush >= DRAFT_KEEPALIVE_MS) void this.flush(s, st)
      }, 5_000)
    } else {
      void this.d.bot.api.sendChatAction(chatId, 'typing', thread).catch(() => {})
      st.typing = setInterval(() => void this.d.bot.api.sendChatAction(chatId, 'typing', thread).catch(() => {}), TYPING_MS)
      const msg = await this.d.bot.api.sendMessage(chatId, t('⏳ Работаю… · {v}', { v: verboseBadge(prefsFor(chatId, threadId).verbose) }), {
        ...thread,
        disable_notification: true,
        reply_markup: stopKeyboard(s.id),
      })
      if (st.closed) {
        // Reply already went out while we were sending — clean up.
        void this.d.bot.api.deleteMessage(chatId, msg.message_id).catch(() => {})
        return
      }
      st.progressMsgId = msg.message_id
      st.lastFlush = Date.now()
      // Re-render periodically so the elapsed time ticks even without events.
      st.ticker = setInterval(() => {
        st.dirty = true
        this.schedule(s, st)
      }, Math.max(settings.groupEditIntervalMs, 5_000))
    }
  }

  onTool(s: Session, line: string): void {
    const st = this.map.get(s.id)
    if (!st || st.closed) return
    if (st.answer) { st.answer = ''; st.dirty = true }
    if (prefsFor(st.chat.chatId, st.chat.threadId).verbose < 1) return
    st.lines.push(line)
    if (st.lines.length > 50) st.lines.splice(0, st.lines.length - 50)
    st.dirty = true
    this.schedule(s, st)
  }

  onText(s: Session, delta: string): void {
    const st = this.map.get(s.id)
    if (!st || st.closed) return
    const p = prefsFor(st.chat.chatId, st.chat.threadId)
    if (p.streamAnswer) st.answer = (st.answer + delta).slice(-8000)
    if (p.verbose >= 2) st.text = (st.text + delta).slice(-8000)
    if (!p.streamAnswer && p.verbose < 2) return
    st.dirty = true
    this.schedule(s, st)
  }

  private schedule(s: Session, st: Stream): void {
    if (st.flushTimer || st.closed) return
    const min = st.chat.isPrivate ? settings.streamMinIntervalMs : settings.groupEditIntervalMs
    const wait = Math.max(0, st.lastFlush + min - Date.now())
    st.flushTimer = setTimeout(() => {
      st.flushTimer = null
      void this.flush(s, st)
    }, wait)
  }

  private render(st: Stream): { thinking: string; body: string } {
    const lines = st.lines.slice(-MAX_LINES)
    const hidden = st.lines.length - lines.length
    const thinking = (hidden > 0 ? t('… ещё {hidden}\n', { hidden }) : '') + lines.join('\n')
    // The answer being written wins over the model's running commentary.
    let body = maskSecrets((st.answer || st.text).trim())
    if (body.length > (st.answer ? MAX_ANSWER : MAX_TEXT)) body = '…' + body.slice(-(st.answer ? MAX_ANSWER : MAX_TEXT))
    return { thinking, body }
  }

  private async flush(s: Session, st: Stream): Promise<void> {
    if (st.closed) return
    await st.opening
    st.dirty = false
    st.lastFlush = Date.now()
    const { chatId, threadId, isPrivate } = st.chat
    const { thinking, body } = this.render(st)
    try {
      if (isPrivate) {
        await sendDraft(this.d.bot, Number(chatId), st.draftId, { thinking, body, canStop: settings.stopMode !== 'off' },
          threadId != null ? { message_thread_id: threadId } : {})
      } else if (st.progressMsgId != null) {
        const head = t('⏳ Работаю… · {v} ({v2})', { v: verboseBadge(prefsFor(chatId, threadId).verbose), v2: fmtDuration(Date.now() - st.startedAt) })
        const text = [head, thinking, body].filter(Boolean).join('\n\n').slice(0, 4000)
        await this.d.bot.api.editMessageText(chatId, st.progressMsgId, text, { reply_markup: stopKeyboard(s.id) })
      }
    } catch (err) {
      if (!isMessageNotModified(err)) this.d.log(`stream flush failed: ${err}`)
    }
  }

  /** The answer for this chat went out: drop the progress view. */
  onReply(s: Session, chatId: string): void {
    const st = this.map.get(s.id)
    if (st && st.chat.chatId === chatId) this.close(s, 'reply')
  }

  close(s: Session, reason: 'reply' | 'stop' | 'stopped' | 'gone' | 'replaced'): void {
    const st = this.map.get(s.id)
    if (!st) return
    this.map.delete(s.id)
    st.closed = true
    if (st.flushTimer) clearTimeout(st.flushTimer)
    if (st.ticker) clearInterval(st.ticker)
    if (st.typing) clearInterval(st.typing)
    if (st.chat.isPrivate || st.progressMsgId == null) return
    const { chatId } = st.chat
    const id = st.progressMsgId
    const took = fmtDuration(Date.now() - st.startedAt)
    if (reason === 'stopped') {
      void this.d.bot.api.editMessageText(chatId, id, t('⏹ Остановлено пользователем ({took})', { took })).catch(() => {})
      return
    }
    const mode = settings.progressFinal
    if (mode === 'keep' || (reason === 'stop' && mode !== 'delete')) {
      void this.d.bot.api.editMessageText(chatId, id, t('✅ Готово ({took})', { took })).catch(() => {})
    } else {
      void this.d.bot.api.deleteMessage(chatId, id).catch(() => {})
    }
  }

  startedAt(s: Session): number | null {
    return this.map.get(s.id)?.startedAt ?? null
  }
}
