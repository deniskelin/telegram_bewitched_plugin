/**
 * Codex asks before a command, an edit or a permission in its own window
 * («Would you like to run the following command?» with «› 1. Yes, just this
 * once …»). Claude's requests come to the chat as a card with buttons; this
 * gives Codex's the same: the request is read off the screen (checked right
 * after each PreToolUse hook and by the question watch) and sent with
 * «✅ Разрешить / ♾ В этой сессии / ❌ Отклонить». A tap moves the selection to
 * that option and presses Enter — only if the same request is still open.
 */

import { InlineKeyboard, type Context } from 'grammy'
import { can } from '../access.ts'
import { escapeHtml } from '../format.ts'
import { k, t } from '../i18n/index.ts'
import type { Daemon, Session } from './daemon.ts'
import { inChat } from './lang.ts'
import { button } from './stream.ts'
import { sessionTarget } from './topics.ts'
import { questionSig, shownQuestions } from './screen.ts'

export type ApprovalKind = 'command' | 'edit' | 'permissions' | 'input'
export type Approval = { kind: ApprovalKind; detail: string; options: string[]; selected: number }

const TITLES: [RegExp, ApprovalKind][] = [
  [/Would you like to run the following command\?/, 'command'],
  [/Would you like to make the following edits\?/, 'edit'],
  [/Would you like to grant these permissions\?/, 'permissions'],
  [/Would you like to send input to the existing terminal\?/, 'input'],
]

/** A Codex approval request on the screen, or null. */
export function parseApproval(screen: string): Approval | null {
  const lines = screen.split('\n')
  const at = lines.findIndex(l => TITLES.some(([re]) => re.test(l)))
  if (at < 0) return null
  const kind = TITLES.find(([re]) => re.test(lines[at]))![1]
  const options: string[] = []
  let selected = 0
  let first = -1
  for (let i = at + 1; i < lines.length; i++) {
    const m = /^\s*(›)?\s*(\d+)\.\s+(.+?)\s*$/.exec(lines[i])
    if (!m) continue
    if (first < 0) first = i
    if (m[1]) selected = options.length
    options.push(m[3].replace(/\s*\((?:[a-z]|esc|enter)\)\s*$/i, ''))
  }
  if (!options.length) return null
  const detail = lines.slice(at + 1, first).map(l => l.replace(/^\s*[│|]\s?/, '').trimEnd()).filter(l => l.trim()).join('\n').trim()
  return { kind, detail, options, selected }
}

/** Which option a button means: once, for the session (or for good), no. */
export function optionFor(a: Approval, choice: 'y' | 'a' | 'n'): number {
  const find = (re: RegExp) => a.options.findIndex(o => re.test(o))
  if (choice === 'y') { const i = find(/^Yes(,|\b)(?!.*(don't ask|allow this host|for this session|in the future|for these))/i); return i >= 0 ? i : find(/^Yes/i) }
  if (choice === 'a') return find(/^Yes.*(don't ask again|for this session|for this conversation)/i)
  const i = find(/^No, and tell Codex/i)
  return i >= 0 ? i : find(/^No\b/i)
}

const KIND_TEXT: Record<ApprovalKind, string> = {
  command: k('запустить команду'),
  edit: k('изменить файлы'),
  permissions: k('выдать разрешения'),
  input: k('отправить ввод в терминал'),
}

/** pane → signature of the request already sent to the chat. */
const sent = new Map<string, string>()

/** If the session's screen shows a Codex approval request not sent yet, send its card. True when one is open. */
export async function checkCodexApproval(d: Daemon, s: Session): Promise<boolean> {
  if (s.engine !== 'codex' || !s.tmuxPane || !/^%\d+$/.test(s.tmuxPane)) return false
  const raw = await d.tmuxCapture(s.tmuxPane)
  const a = raw ? parseApproval(raw) : null
  if (!a) { sent.delete(s.tmuxPane); return false }
  const sig = questionSig(raw!)
  if (sent.get(s.tmuxPane) === sig) return true
  sent.set(s.tmuxPane, sig)
  // The generic question watch stays quiet about it: this card is the answer.
  shownQuestions.set(s.tmuxPane, sig)
  const c = s.lastChat ?? sessionTarget(d, s)
  if (!c) return true
  d.log(`session ${s.id}: Codex asks to ${a.kind} — card sent (${a.options.length} options)`)
  const always = optionFor(a, 'a') >= 0
  const kb = new InlineKeyboard([
    [button(t('✅ Разрешить'), `cxa:y:${s.id}`, 'primary'), button(t('❌ Отклонить'), `cxa:n:${s.id}`, 'danger')],
    ...(always ? [[button(t('♾ Не спрашивать в этой сессии'), `cxa:a:${s.id}`)]] : []),
    [button(t('👁 Экран и клавиши'), `tx:p${s.tmuxPane.slice(1)}`)],
  ])
  const detail = a.detail ? `\n<pre>${escapeHtml(a.detail.length > 1500 ? a.detail.slice(0, 1499) + '…' : a.detail)}</pre>` : ''
  await inChat(d, c.chatId, c.threadId, () => d.bot.api.sendMessage(c.chatId, t('🔐 Codex (#{id}) просит {what}:', { id: s.id, what: t(KIND_TEXT[a.kind]) }) + detail, {
    parse_mode: 'HTML', reply_markup: kb, ...(c.threadId != null ? { message_thread_id: c.threadId } : {}),
  })).catch(err => d.log(`codex approval card failed: ${err}`))
  return true
}

/** After a PreToolUse of a Codex session: its approval request (if any) shows up within a second or two. */
export function watchApprovalSoon(d: Daemon, s: Session): void {
  if (s.engine !== 'codex') return
  for (const ms of [1200, 4000]) setTimeout(() => void checkCodexApproval(d, s).catch(err => d.log(`codex approval check failed: ${err}`)), ms).unref?.()
}

/** cxa:<y|a|n>:<session> — answer the open request with the matching option. */
export async function handleCodexApprovalCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^cxa:([yan]):([0-9a-f]+)$/.exec(data)
  if (!m) return false
  const answer = (text: string) => ctx.answerCallbackQuery({ text }).catch(() => {})
  if (!ctx.from || !can(ctx.from.id, 'permissions')) { await answer(t('Нет доступа.')); return true }
  const choice = m[1] as 'y' | 'a' | 'n'
  const s = d.sessions.get(m[2])
  if (!s?.tmuxPane) { await answer(t('Сессия уже отключилась.')); return true }
  const raw = await d.tmuxCapture(s.tmuxPane)
  const a = raw ? parseApproval(raw) : null
  if (!a) {
    await answer(t('Запрос уже закрыт.'))
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
    return true
  }
  const target = optionFor(a, choice)
  const keys = target >= 0
    ? [...Array(Math.abs(target - a.selected)).fill(target > a.selected ? 'Down' : 'Up'), 'Enter']
    : choice === 'n' ? ['Escape'] : null
  if (!keys) { await answer(t('Такого варианта на экране нет — ответьте клавишами.')); return true }
  await d.tmuxKeys(s.tmuxPane, keys)
  sent.delete(s.tmuxPane)
  d.log(`session ${s.id}: Codex request answered «${target >= 0 ? a.options[target] : 'Escape'}» by ${ctx.from.id}`)
  const label = choice === 'y' ? t('✅ Разрешено') : choice === 'a' ? t('♾ Разрешено до конца сессии') : t('❌ Отклонено')
  await answer(label)
  const text = (ctx.callbackQuery?.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '') ?? ''
  await ctx.editMessageText(`${escapeHtml(text)}\n\n${label}`, { parse_mode: 'HTML', reply_markup: undefined }).catch(() => {})
  return true
}
