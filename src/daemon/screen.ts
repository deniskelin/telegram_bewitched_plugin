/**
 * 👁 The screen of a tmux pane or window in Telegram, with a few keys: enough
 * to accept the channels prompt of a new session or see where one is stuck,
 * without `tmux attach`.
 *
 * Callback data: tx:<target>[:<key>], target p<N> = pane %N, w<N> = window N
 * of TMUX_SESSION. Keys are a fixed set; nothing typed by the user reaches tmux.
 * Besides keys: c — accept the development-channels prompt (only when it is
 * on the screen), l / s — start / stop refreshing the screen for a minute.
 */

import { InlineKeyboard, type Context } from 'grammy'
import { isOwner } from '../access.ts'
import { settings } from '../config.ts'
import { escapeHtml, maskSecrets } from '../format.ts'
import { isMessageNotModified } from '../tg.ts'
import type { Daemon } from './daemon.ts'
import { button } from './stream.ts'
import { locale, k, t } from '../i18n/index.ts'

const LINES = 40
const MAX_CHARS = 3500
/** Live screen: refresh every LIVE_EVERY_MS for LIVE_MS (well under Telegram's edit limits). */
const LIVE_MS = 60_000
const LIVE_EVERY_MS = 4000

/** Claude Code's prompt at the start of a session loaded with --dangerously-load-development-channels. */
const CHANNELS_TITLE = 'Loading development channels'
const CHANNELS_CONFIRM = 'I am using this for local development'

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

export function isChannelsPrompt(raw: string | null): boolean {
  return !!raw && raw.includes(CHANNELS_TITLE) && raw.includes(CHANNELS_CONFIRM)
}

/**
 * Accept the development-channels prompt: Enter when the confirm option has
 * the focus (❯), Up when "Exit" has it, "1" otherwise. Nothing is pressed
 * unless that exact prompt is on the screen — not on a folder-trust question
 * or anything else. Returns what was on the screen at the end.
 */
export async function acceptChannels(d: Daemon, target: string): Promise<'accepted' | 'no_prompt' | 'stuck'> {
  for (let i = 0; i < 3; i++) {
    const raw = await d.tmuxCapture(target)
    if (!isChannelsPrompt(raw)) return i ? 'accepted' : 'no_prompt'
    const focus = raw!.split('\n').find(l => l.includes('❯')) ?? ''
    const key = focus.includes(CHANNELS_CONFIRM) ? 'Enter' : /\bExit\b/.test(focus) ? 'Up' : '1'
    await d.tmuxKeys(target, [key])
    await Bun.sleep(settings.screenRedrawMs)
  }
  return isChannelsPrompt(await d.tmuxCapture(target)) ? 'stuck' : 'accepted'
}

/** Live screens by "chat:message": when the refreshing stops. */
const live = new Map<string, number>()

export async function screenView(d: Daemon, code: string, liveOn = false): Promise<{ text: string; kb: InlineKeyboard; gone: boolean }> {
  const target = tmuxTarget(code)!
  const raw = await d.tmuxCapture(target)
  const session = code.startsWith('p') ? [...d.sessions.values()].find(s => s.tmuxPane === target) : undefined
  const time = new Date().toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const head = t('🖥 <b>Экран</b> <code>{v}</code>{v2} · {time}{v3}', { v: escapeHtml(target), v2: session ? ` · #${session.id}` : '', time, v3: liveOn ? t(' · ▶️ обновляется') : '' })
  const text = raw == null ? t('{head}\n\nОкно не найдено: сессия закрыта или tmux перезапущен.', { head }) : `${head}\n<pre>${escapeHtml(screenText(raw)) || ' '}</pre>`
  const key = (c: string) => button(KEYS[c].label, `tx:${code}:${c}`)
  const rows = raw == null ? [] : [[key('1'), key('2'), key('3'), key('e'), key('x')], [key('u'), key('d'), key('t'), button('🔄', `tx:${code}`),
    liveOn ? button('⏸', `tx:${code}:s`) : button(t('▶️ 1 мин'), `tx:${code}:l`)]]
  if (isChannelsPrompt(raw)) rows.unshift([button(t('✅ Подтвердить запуск'), `tx:${code}:c`, 'success')])
  if (session) rows.push([button(t('« К сессии'), `sm:s:${session.id}`)])
  return { text, kb: new InlineKeyboard(rows), gone: raw == null }
}

export async function handleScreenCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^tx:([pw]\d+)(?::(\w))?$/.exec(data)
  if (!m) return false
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await answer(t('Нет доступа.'))
    return true
  }
  const [, code, key] = m
  const msg = ctx.callbackQuery?.message
  const liveKey = msg ? `${msg.chat.id}:${msg.message_id}` : ''
  if (key === 'c') {
    const r = await acceptChannels(d, tmuxTarget(code)!)
    if (r === 'no_prompt') await answer(t('На экране нет запроса о каналах — смотрите сами 👁'))
    else await answer(r === 'accepted' ? t('✅ Запуск подтверждён') : t('Не вышло — нажмите клавиши вручную'))
    await edit(d, ctx, code, live.has(liveKey))
    return true
  }
  if (key === 'l' || key === 's') {
    if (key === 's' || !msg) live.delete(liveKey)
    else if (!live.has(liveKey)) {
      live.set(liveKey, Date.now() + LIVE_MS)
      void runLive(d, msg.chat.id, msg.message_id, code, liveKey)
    }
    await answer(key === 'l' ? t('▶️ Обновляю минуту') : t('⏸ Остановлено'))
    await edit(d, ctx, code, live.has(liveKey))
    return true
  }
  if (key) {
    const k = KEYS[key]
    if (!k) { await answer(); return true }
    await d.tmuxKeys(tmuxTarget(code)!, [k.key]).catch(err => d.log(`tmux keys failed: ${err}`))
    // Let the program redraw before the next capture.
    await Bun.sleep(settings.screenRedrawMs)
  }
  await edit(d, ctx, code, live.has(liveKey))
  await answer(key ? t('Нажато: {v}', { v: KEYS[key]?.label ?? key }) : undefined)
  return true
}

async function edit(d: Daemon, ctx: Context, code: string, liveOn: boolean): Promise<void> {
  const v = await screenView(d, code, liveOn)
  await ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.kb })
    .catch(async err => {
      if (isMessageNotModified(err)) return
      // The launch notice is in a topic or DM: post the screen as its own message.
      if (ctx.chat) await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.kb, ...(ctx.callbackQuery?.message?.message_thread_id ? { message_thread_id: ctx.callbackQuery.message.message_thread_id } : {}) })
    })
}

/** Refresh the screen message until LIVE_MS passes, ⏸ is pressed or the window is gone. */
async function runLive(d: Daemon, chatId: number, messageId: number, code: string, key: string): Promise<void> {
  while ((live.get(key) ?? 0) > Date.now()) {
    await Bun.sleep(LIVE_EVERY_MS)
    if (!live.has(key)) return
    const on = (live.get(key) ?? 0) > Date.now()
    if (!on) live.delete(key)
    const v = await screenView(d, code, on)
    const ok = await d.bot.api.editMessageText(chatId, messageId, v.text, { parse_mode: 'HTML', reply_markup: v.kb })
      .then(() => true, err => isMessageNotModified(err))
    if (!ok || v.gone) break
  }
  live.delete(key)
}
