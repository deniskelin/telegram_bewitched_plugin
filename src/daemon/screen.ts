/**
 * 👁 The screen of a tmux pane or window in Telegram, with a few keys: enough
 * to accept the channels prompt of a new session or see where one is stuck,
 * without `tmux attach`.
 *
 * Callback data: tx:<target>[:<key>], target p<N> = pane %N, w<N> = window N
 * of TMUX_SESSION. Keys are a fixed set; nothing typed by the user reaches tmux.
 * Besides keys: c — confirm the launch: answer the startup questions of a
 * new session (folder trust, development channels — only those) one after
 * another until the session connects; l / s — start / stop refreshing the
 * screen for a minute; z — delete the message.
 */

import { InlineKeyboard, type Context } from 'grammy'
import { can } from '../access.ts'
import { settings } from '../config.ts'
import { escapeHtml, maskSecrets } from '../format.ts'
import { isMessageNotModified } from '../tg.ts'
import type { Daemon } from './daemon.ts'
import { button } from './stream.ts'
import { locale, k, t } from '../i18n/index.ts'
import { projectTitle } from './report.ts'

const LINES = 40
const MAX_CHARS = 3500
/** Live screen: refresh every LIVE_EVERY_MS for LIVE_MS (well under Telegram's edit limits). */
const LIVE_MS = 60_000
const LIVE_EVERY_MS = 4000

/** How long «✅ Подтвердить запуск» keeps answering prompts and waiting for the session to connect. */
const CONFIRM_MS = 120_000

/**
 * The questions Claude Code asks when a session starts, as it draws them:
 * a title and the confirm option. «✅ Подтвердить запуск» answers these and
 * nothing else. The trust dialog has its focus on «No» by default.
 */
const STARTUP_PROMPTS = [
  { title: 'Accessing workspace', confirm: 'Yes, I trust this folder' },
  { title: 'Loading development channels', confirm: 'I am using this for local development' },
] as const

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

/** The startup question on the screen, if any. */
function startupPrompt(raw: string | null): (typeof STARTUP_PROMPTS)[number] | null {
  if (!raw) return null
  return STARTUP_PROMPTS.find(p => raw.includes(p.title) && raw.includes(p.confirm)) ?? null
}

export function isStartupPrompt(raw: string | null): boolean {
  return startupPrompt(raw) != null
}

/**
 * The key that moves toward the confirm option of a startup question: Enter
 * when it has the focus (❯), else ↑/↓ toward it. Null when there is no such
 * question or no visible focus — then nothing is pressed.
 */
export function confirmKey(raw: string | null): string | null {
  const p = startupPrompt(raw)
  if (!p) return null
  const lines = raw!.split('\n')
  const focus = lines.findIndex(l => l.includes('❯'))
  const confirm = lines.findIndex(l => l.includes(p.confirm))
  if (focus < 0 || confirm < 0) return null
  return focus === confirm ? 'Enter' : confirm > focus ? 'Down' : 'Up'
}

export type ConfirmResult = { result: 'connected'; sessionId: string } | { result: 'no_prompt' | 'stuck' | 'gone' | 'timeout' }

/**
 * Answer the startup questions of the session in target one by one until it
 * connects (CONFIRM_MS at most). Only the questions in STARTUP_PROMPTS are
 * answered; anything else on the screen stops it ("stuck").
 */
export async function confirmLaunch(d: Daemon, target: string, onStep: () => Promise<void> = async () => {}): Promise<ConfirmResult> {
  const pane = target.startsWith('%') ? target : await d.tmuxPaneId(target)
  const deadline = Date.now() + CONFIRM_MS
  let answered = false
  for (let presses = 0; Date.now() < deadline && presses < 20;) {
    const s = pane ? d.activeSessions().find(x => x.tmuxPane === pane) : undefined
    if (s) return { result: 'connected', sessionId: s.id }
    const raw = await d.tmuxCapture(target)
    if (raw == null) return { result: 'gone' }
    if (isStartupPrompt(raw)) {
      const key = confirmKey(raw)
      if (!key) return { result: 'stuck' }
      await d.tmuxKeys(target, [key])
      presses++
      answered = true
      await Bun.sleep(settings.screenRedrawMs)
      await onStep().catch(() => {})
      continue
    }
    // Nothing asked and nothing answered yet: not a session waiting on us.
    if (!answered) return { result: 'no_prompt' }
    await Bun.sleep(settings.confirmPollMs)
  }
  return { result: 'timeout' }
}

/** Confirmations running, by tmux target: a second tap doesn't start another. */
const confirming = new Set<string>()

/** Live screens by "chat:message": when the refreshing stops. */
const live = new Map<string, number>()

export async function screenView(d: Daemon, code: string, liveOn = false, note = ''): Promise<{ text: string; kb: InlineKeyboard; gone: boolean }> {
  const target = tmuxTarget(code)!
  const raw = await d.tmuxCapture(target)
  const session = code.startsWith('p') ? [...d.sessions.values()].find(s => s.tmuxPane === target) : undefined
  const time = new Date().toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const head = t('🖥 <b>Экран</b> <code>{v}</code>{v2} · {time}{v3}', { v: escapeHtml(target), v2: session ? ` · #${session.id}` : '', time, v3: liveOn ? t(' · ▶️ обновляется') : '' })
  const body = raw == null ? t('{head}\n\nОкно не найдено: сессия закрыта или tmux перезапущен.', { head }) : `${head}\n<pre>${escapeHtml(screenText(raw)) || ' '}</pre>`
  const text = note ? `${body}\n${note}` : body
  const key = (c: string) => button(KEYS[c].label, `tx:${code}:${c}`)
  const rows = raw == null ? [] : [[key('1'), key('2'), key('3'), key('e'), key('x')], [key('u'), key('d'), key('t'), button('🔄', `tx:${code}`),
    liveOn ? button('⏸', `tx:${code}:s`) : button(t('▶️ 1 мин'), `tx:${code}:l`)]]
  if (isStartupPrompt(raw) && !confirming.has(tmuxTarget(code)!)) rows.unshift([button(t('✅ Подтвердить запуск'), `tx:${code}:c`, 'success')])
  rows.push([...(session ? [button(t('« К сессии'), `sm:s:${session.id}`)] : []), button(t('✖️ Закрыть'), `tx:${code}:z`)])
  return { text, kb: new InlineKeyboard(rows), gone: raw == null }
}

export async function handleScreenCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^tx:([pw]\d+)(?::(\w))?$/.exec(data)
  if (!m) return false
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || !can(ctx.from.id, 'control')) {
    await answer(t('Нет доступа.'))
    return true
  }
  const [, code, key] = m
  const msg = ctx.callbackQuery?.message
  const liveKey = msg ? `${msg.chat.id}:${msg.message_id}` : ''
  if (key === 'z') {
    await answer()
    live.delete(liveKey)
    await ctx.deleteMessage().catch(() => ctx.editMessageText(t('✖️ Закрыто')).catch(() => {}))
    return true
  }
  if (key === 'c') {
    const target = tmuxTarget(code)!
    if (confirming.has(target)) { await answer(t('Уже подтверждаю…')); return true }
    if (!isStartupPrompt(await d.tmuxCapture(target))) {
      await answer(t('На экране нет вопросов запуска — смотрите сами 👁'))
      await edit(d, ctx, code, live.has(liveKey))
      return true
    }
    await answer(t('✅ Подтверждаю запуск…'))
    live.delete(liveKey)
    confirming.add(target)
    // In the background: the bot keeps handling other updates meanwhile.
    void runConfirm(d, ctx, code, target).finally(() => confirming.delete(target))
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

/** «✅ Подтвердить запуск»: answer the questions, show progress, close the screen once the session is in. */
async function runConfirm(d: Daemon, ctx: Context, code: string, target: string): Promise<void> {
  const progress = t('⏳ Подтверждаю запуск — жду, пока сессия подключится…')
  await edit(d, ctx, code, false, progress)
  const r = await confirmLaunch(d, target, () => edit(d, ctx, code, false, progress))
  if (r.result === 'connected') {
    const s = d.sessions.get(r.sessionId)
    const done = t('✅ Сессия #{id} подключилась — можно писать.', { id: r.sessionId }) + (s ? ` ${projectTitle(s)}` : '')
    await ctx.editMessageText(done, { reply_markup: new InlineKeyboard([[button(t('✖️ Закрыть'), `tx:${code}:z`)]]) }).catch(() => {})
    return
  }
  const note = r.result === 'gone' ? t('❌ Окно закрылось — сессия не запустилась.')
    : r.result === 'timeout' ? t('⌛ Сессия так и не подключилась — посмотрите экран.')
    : t('⚠️ На экране вопрос, на который я не отвечаю сам, — ответьте клавишами.')
  await edit(d, ctx, code, false, note)
}

async function edit(d: Daemon, ctx: Context, code: string, liveOn: boolean, note = ''): Promise<void> {
  const v = await screenView(d, code, liveOn, note)
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
