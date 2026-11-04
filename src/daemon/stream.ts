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
import { clip, escapeHtml, fmtDuration, maskSecrets } from '../format.ts'
import { editRich, isMessageNotModified, sendDraft } from '../tg.ts'
import type { ChatRef, Daemon, Session } from './daemon.ts'
import { t } from '../i18n/index.ts'
import { inChat } from './lang.ts'
import { BUTTON_EMOJI } from './button-emoji.ts'

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
  /** The group progress message is edited as a rich message, until Telegram refuses one. */
  rich: boolean
  /** FR-12: the model's plan (TodoWrite), shown as a checklist. */
  plan: PlanItem[]
}

export type PlanItem = { content: string; status: 'pending' | 'in_progress' | 'completed' }

const PLAN_MARK: Record<PlanItem['status'], string> = { completed: '☑️', in_progress: '▶️', pending: '⬜' }

/** TodoWrite's input → plan items (anything malformed is dropped). */
export function parsePlan(input: unknown): PlanItem[] {
  const todos = (input as { todos?: unknown } | undefined)?.todos
  if (!Array.isArray(todos)) return []
  return todos.flatMap((x): PlanItem[] => {
    const o = x as { content?: unknown; activeForm?: unknown; status?: unknown }
    const content = typeof o?.content === 'string' ? o.content : ''
    const status: PlanItem['status'] = o?.status === 'completed' ? 'completed' : o?.status === 'in_progress' ? 'in_progress' : 'pending'
    return content ? [{ content: status === 'in_progress' && typeof o.activeForm === 'string' && o.activeForm ? o.activeForm : content, status }] : []
  }).slice(0, 30)
}

/** The plan as lines: ☑️ done, ▶️ in progress, ⬜ to do, with a done/total head. */
export function planLines(plan: PlanItem[]): string[] {
  if (!plan.length) return []
  const done = plan.filter(p => p.status === 'completed').length
  return [t('📋 План: {done}/{n}', { done, n: plan.length }), ...plan.map(p => `${PLAN_MARK[p.status]} ${clip(p.content, 120)}`)]
}

/** The plan as a rich Markdown checklist. */
export function planMarkdown(plan: PlanItem[]): string {
  if (!plan.length) return ''
  const done = plan.filter(p => p.status === 'completed').length
  return [`**${escapeHtml(t('📋 План: {done}/{n}', { done, n: plan.length }))}**`, ...plan.map(p => `- [${p.status === 'completed' ? 'x' : ' '}] ${p.status === 'in_progress' ? '**' : ''}${escapeHtml(clip(p.content, 120))}${p.status === 'in_progress' ? '**' : ''}`)].join('\n')
}

/**
 * Telegram refused an edit because of timing, not because of the content:
 * a newer edit of the same message won (the answer took the progress message
 * over), the message is gone, or too many edits. Nothing to downgrade or log.
 */
function isEditRace(err: unknown): boolean {
  const d = err instanceof Error ? err.message : String(err)
  return /canceled by new edit message request|message to edit not found|Too Many Requests/i.test(d)
}

export function stopKeyboard(sessionId: string): InlineKeyboard | undefined {
  return settings.stopMode === 'off' ? undefined : new InlineKeyboard([[button(t('⏹ Стоп'), `stop:${sessionId}`, 'danger')]])
}

export type ButtonStyle = 'primary' | 'success' | 'danger'

/** Callback button with Bot API 9.4 `style` (unknown to the bundled grammY types). */
export function button(text: string, data: string, style?: ButtonStyle, disabled = false) {
  const { label, icon } = buttonIcon(text)
  return { text: clip(label, 64), callback_data: data, ...(icon ? { icon_custom_emoji_id: icon } : {}), ...(style ? { style } : {}), ...(disabled ? { disabled: {} } : {}) } as { text: string; callback_data: string }
}

/** URL button with the same custom icon as button(). */
export function urlButton(text: string, url: string) {
  const { label, icon } = buttonIcon(text)
  return { text: clip(label, 64), url, ...(icon ? { icon_custom_emoji_id: icon } : {}) } as { text: string; url: string }
}

/**
 * A leading emoji with a custom one in BUTTON_EMOJI becomes the button's
 * icon and leaves the label; «• » (the current choice) stays in front.
 */
export function buttonIcon(text: string): { label: string; icon?: string } {
  const m = /^(• )?(\S+?)\uFE0F? (.*)$/su.exec(text)
  const icon = m ? BUTTON_EMOJI[m[2].replace(/\uFE0F/g, '')] : undefined
  return icon && m ? { label: `${m[1] ?? ''}${m[3]}`, icon } : { label: text }
}

const progressKey = (chatId: string, id: number) => `progress_msg:${chatId}:${id}`

/**
 * After a daemon start: progress messages of turns the previous daemon did
 * not close (it restarted or crashed mid-turn) stop pretending to work — no
 * ⏹, a line saying why. The session keeps working; its answer comes as a
 * message of its own.
 */
export async function closeOrphanProgress(d: Daemon): Promise<void> {
  for (const key of d.store.keys('progress_msg:')) {
    d.store.set(key, null)
    const m = /^progress_msg:(-?\d+):(\d+)$/.exec(key)
    if (!m) continue
    d.log(`progress message ${m[2]} in ${m[1]} left by the previous daemon, closing it`)
    await inChat(d, m[1], undefined, () => d.bot.api.editMessageText(m[1], Number(m[2]), t('⚪️ Прогресс прервался: демон перезапускался. Ответ придёт отдельным сообщением.'), { reply_markup: { inline_keyboard: [] } }))
      .catch(err => d.log(`orphan progress ${m[2]}: ${err}`))
  }
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
      rich: true,
      plan: [],
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
      // Remembered until it is closed: a daemon restart mid-turn would leave it «⏳ Работаю…» with ⏹ for good.
      this.d.store.set(progressKey(chatId, msg.message_id), s.id)
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

  /** FR-12: TodoWrite — the plan shows as a live checklist in the progress (whatever the verbosity). */
  onPlan(s: Session, plan: PlanItem[]): void {
    const st = this.map.get(s.id)
    if (!st || st.closed || !plan.length) return
    st.plan = plan
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
    // FR-13: the current step first, the steps done below it (newest first).
    const [current, ...past] = [...lines].reverse()
    const steps = current ? [`▸ ${current}`, ...past.map(l => `· ${l}`), ...(hidden > 0 ? [t('… ещё {hidden}', { hidden })] : [])].join('\n') : ''
    const plan = planLines(st.plan).join('\n')
    const thinking = [plan, steps].filter(Boolean).join('\n\n')
    // The answer being written wins over the model's running commentary.
    let body = maskSecrets((st.answer || st.text).trim())
    const max = st.answer ? MAX_ANSWER : MAX_TEXT
    if (body.length > max) {
      const cut = body.length - max
      // Cut inside a code block: reopen it, or the rest would read as text.
      const reopen = (body.slice(0, cut).match(/^\s*```/gm)?.length ?? 0) % 2 === 1
      body = (reopen ? '```\n' : '') + '…' + body.slice(cut)
    }
    return { thinking, body }
  }

  /** The group progress message as rich Markdown: the header, the steps as a collapsible quote, then the answer. */
  private richProgress(st: Stream, thinking: string, body: string): string {
    const { chatId, threadId } = st.chat
    const head = `**${escapeHtml(t('⏳ Работаю…'))}** · ${verboseBadge(prefsFor(chatId, threadId).verbose)} · ${fmtDuration(Date.now() - st.startedAt)}`
    // The plan is a checklist of its own; the steps (without the plan's lines) fold into a quote.
    const plan = planMarkdown(st.plan)
    const stepText = plan ? thinking.split('\n\n').slice(1).join('\n\n') : thinking
    const steps = stepText ? `<blockquote expandable>${stepText.split('\n').map(escapeHtml).join('<br>')}</blockquote>` : ''
    return [head, plan, steps, body ? `---\n\n${body}` : ''].filter(Boolean).join('\n\n')
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
        const id = st.progressMsgId
        if (st.rich) {
          try {
            await editRich(this.d.bot, chatId, id, this.richProgress(st, thinking, body), { reply_markup: stopKeyboard(s.id) })
            return
          } catch (err) {
            if (isMessageNotModified(err)) return
            // The message was handed to the answer meanwhile (takeProgress), or the edit merely lost a race:
            // nothing to fall back to — a plain edit would put the progress over the answer.
            if (st.closed || st.progressMsgId !== id || isEditRace(err)) return
            st.rich = false
            this.d.log(`rich progress failed, plain text from now on: ${err}`)
          }
        }
        const head = t('⏳ Работаю… · {v} ({v2})', { v: verboseBadge(prefsFor(chatId, threadId).verbose), v2: fmtDuration(Date.now() - st.startedAt) })
        const text = [head, thinking, body].filter(Boolean).join('\n\n').slice(0, 4000)
        if (st.closed || st.progressMsgId !== id) return
        await this.d.bot.api.editMessageText(chatId, id, text, { reply_markup: stopKeyboard(s.id) })
      }
    } catch (err) {
      if (!isMessageNotModified(err) && !isEditRace(err)) this.d.log(`stream flush failed: ${err}`)
    }
  }

  /**
   * FR-11: the answer is about to go out in a group, and the chat ends a
   * streamed answer by editing: hand over the progress message (it becomes the
   * answer) and stop the stream without touching it. Null — no such message.
   */
  takeProgress(s: Session, chatId: string): number | null {
    const st = this.map.get(s.id)
    if (!st || st.closed || st.chat.isPrivate || st.chat.chatId !== chatId || st.progressMsgId == null) return null
    if (prefsFor(st.chat.chatId, st.chat.threadId).streamFinal !== 'edit') return null
    const id = st.progressMsgId
    st.progressMsgId = null
    this.d.store.set(progressKey(chatId, id), null)
    this.close(s, 'reply')
    return id
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
    this.d.store.set(progressKey(chatId, id), null)
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

  /** The session whose native draft this is (the draft's own stop button). */
  sessionByDraft(chatId: string, draftId: number): string | null {
    for (const [id, st] of this.map) if (st.chat.chatId === chatId && st.draftId === draftId) return id
    return null
  }

  startedAt(s: Session): number | null {
    return this.map.get(s.id)?.startedAt ?? null
  }
}
