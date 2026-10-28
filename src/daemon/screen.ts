/**
 * 👁 The screen of a tmux pane or window in Telegram, with a few keys: enough
 * to accept the channels prompt of a new session or see where one is stuck,
 * without `tmux attach`.
 *
 * Callback data: tx:<target>[:<key>], target p<N> = pane %N, w<N> = window N
 * of TMUX_SESSION. Keys are a fixed set; nothing typed by the user reaches tmux.
 */

import { InlineKeyboard, type Context } from 'grammy'
import { isOwner } from '../access.ts'
import { settings } from '../config.ts'
import { escapeHtml, maskSecrets } from '../format.ts'
import { isMessageNotModified } from '../tg.ts'
import type { Daemon } from './daemon.ts'
import { button } from './stream.ts'

const LINES = 40
const MAX_CHARS = 3500

const KEYS: Record<string, { label: string; key: string }> = {
  '1': { label: '1', key: '1' },
  '2': { label: '2', key: '2' },
  '3': { label: '3', key: '3' },
  e: { label: '⏎ Enter', key: 'Enter' },
  x: { label: 'Esc', key: 'Escape' },
  u: { label: '↑', key: 'Up' },
  d: { label: '↓', key: 'Down' },
  t: { label: 'Tab', key: 'Tab' },
}

/** p9 → %9, w3 → <TMUX_SESSION>:3; anything else is refused. */
export function tmuxTarget(code: string): string | null {
  if (/^p\d+$/.test(code)) return `%${code.slice(1)}`
  if (/^w\d+$/.test(code)) return `${settings.tmuxSession}:${code.slice(1)}`
  return null
}

/** The visible lines without trailing blanks, the last LINES of them. */
export function screenText(raw: string): string {
  // Rules across the full terminal width only make the phone wrap them.
  const lines = raw.replace(/\s+$/, '').split('\n').map(l => l.replace(/\s+$/, '').replace(/[─━]{24,}/g, m => m.slice(0, 24)))
  let text = maskSecrets(lines.slice(-LINES).join('\n'))
  if (text.length > MAX_CHARS) text = '…' + text.slice(-MAX_CHARS)
  return text
}

export async function screenView(d: Daemon, code: string): Promise<{ text: string; kb: InlineKeyboard }> {
  const target = tmuxTarget(code)!
  const raw = await d.tmuxCapture(target)
  const session = code.startsWith('p') ? [...d.sessions.values()].find(s => s.tmuxPane === target) : undefined
  const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const head = `🖥 <b>Экран</b> <code>${escapeHtml(target)}</code>${session ? ` · #${session.id}` : ''} · ${time}`
  const text = raw == null ? `${head}\n\nОкно не найдено: сессия закрыта или tmux перезапущен.` : `${head}\n<pre>${escapeHtml(screenText(raw)) || ' '}</pre>`
  const k = (c: string) => button(KEYS[c].label, `tx:${code}:${c}`)
  const rows = raw == null ? [] : [[k('1'), k('2'), k('3'), k('e'), k('x')], [k('u'), k('d'), k('t'), button('🔄', `tx:${code}`)]]
  if (session) rows.push([button('« К сессии', `sm:s:${session.id}`)])
  return { text, kb: new InlineKeyboard(rows) }
}

export async function handleScreenCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^tx:([pw]\d+)(?::(\w))?$/.exec(data)
  if (!m) return false
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await answer('Нет доступа.')
    return true
  }
  const [, code, key] = m
  if (key) {
    const k = KEYS[key]
    if (!k) { await answer(); return true }
    await d.tmuxKeys(tmuxTarget(code)!, [k.key]).catch(err => d.log(`tmux keys failed: ${err}`))
    // Let the program redraw before the next capture.
    await Bun.sleep(settings.screenRedrawMs)
  }
  const v = await screenView(d, code)
  await ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.kb })
    .catch(async err => {
      if (isMessageNotModified(err)) return
      // The launch notice is in a topic or DM: post the screen as its own message.
      if (ctx.chat) await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.kb, ...(ctx.callbackQuery?.message?.message_thread_id ? { message_thread_id: ctx.callbackQuery.message.message_thread_id } : {}) })
    })
  await answer(key ? `Нажато: ${KEYS[key]?.label ?? key}` : undefined)
  return true
}
