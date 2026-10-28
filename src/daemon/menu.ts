/**
 * /sessions as a menu in one message, like BotFather: the list of sessions
 * with a button each; a button opens the session's card with its actions and
 * the progress settings of its chat; « Назад returns to the list.
 */

import { InlineKeyboard, type Context } from 'grammy'
import { isOwner, NOTIFY_DONE_INFO, prefsFor, setPref, verboseBadge } from '../access.ts'
import { escapeHtml } from '../format.ts'
import { isMessageNotModified, topicLink } from '../tg.ts'
import type { Daemon, Session } from './daemon.ts'
import { stopSession } from './inbound.ts'
import { footer, passiveBlock, sessionCard, sessionChat, sessionLabel, sortedSessions, statusLabel } from './report.ts'
import { button } from './stream.ts'
import { archiveTopic } from './topics.ts'

const MAX_MESSAGE = 4000
type Screen = { text: string; kb: InlineKeyboard }
type Btn = ReturnType<typeof button> | ReturnType<typeof InlineKeyboard.url>

export async function sessionsList(d: Daemon): Promise<Screen> {
  const list = sortedSessions(d)
  const lines = list.map(s => {
    const label = sessionLabel(d, s)
    const icon = label.slice(0, label.indexOf(' '))
    return `${icon} <b>${escapeHtml(label.slice(icon.length + 1))}</b> · ${statusLabel(s)}${s.topic ? ` · 💬 ${escapeHtml(s.topic.name)}` : ''}`
  })
  const blocks = [`📋 <b>Сессии</b> (${list.length})`, lines.length ? `${lines.join('\n')}\n\nВыберите сессию:` : 'Нет запущенных сессий.']
  const passive = await passiveBlock(d)
  if (passive) blocks.push(passive)
  blocks.push(footer(d))
  let text = blocks.join('\n\n')
  if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE - 1) + '…'

  const rows: Btn[][] = []
  for (const [i, s] of list.entries()) {
    const b = button(`${sessionLabel(d, s)} ${statusLabel(s).slice(0, 2)}`.slice(0, 40), `sm:s:${s.id}`)
    if (i % 2 === 0) rows.push([b])
    else rows.at(-1)!.push(b)
  }
  rows.push([button('🔄 Обновить', 'sm:list')])
  return { text, kb: new InlineKeyboard(rows as never) }
}

export async function sessionScreen(d: Daemon, s: Session): Promise<Screen> {
  const c = sessionChat(d, s)
  const p = prefsFor(c.chatId, c.threadId)
  const rows: Btn[][] = []

  const actions: Btn[] = []
  if (s.tmuxPane && s.status === 'working') actions.push(button('⏹ Стоп', `sm:stop:${s.id}`, 'danger'))
  if (s !== d.mainSession() && !d.userIdOf(s)) actions.push(button('👑 Сделать главной', `sm:main:${s.id}`))
  if (s.topic) actions.push(button('🗄 В архив', `sm:ar:${s.id}`))
  if (actions.length) rows.push(actions)
  const link = s.topic ? topicLink(s.topic.chatId, s.topic.threadId) : null
  if (link) rows.push([InlineKeyboard.url(`💬 Открыть топик «${s.topic!.name}»`.slice(0, 40), link)])

  // The current value is marked; tapping it again does nothing harmful.
  rows.push(([0, 1, 2] as const).map(v => button(`${p.verbose === v ? '• ' : ''}${verboseBadge(v)}`, `sm:v:${s.id}:${v}`, p.verbose === v ? 'primary' : undefined)))
  rows.push((['off', 'long', 'always'] as const).map(v => button(`${p.notifyDone === v ? '• ' : ''}✅ ${NOTIFY_DONE_INFO[v].replace('после долгих ходов', 'долгие')}`, `sm:n:${s.id}:${v}`, p.notifyDone === v ? 'primary' : undefined)))
  rows.push([button('« К списку', 'sm:list'), button('🔄', `sm:s:${s.id}`)])

  const where = c.threadId != null ? 'в топике' : d.userIdOf(s) ? 'в личке пользователя' : 'в личке'
  const text = `${await sessionCard(d, s)}\n\n<i>Подробность прогресса и «✅ готово» ${where}:</i>`
  return { text, kb: new InlineKeyboard(rows as never) }
}

async function show(ctx: Context, sc: Screen): Promise<void> {
  await ctx.editMessageText(sc.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: sc.kb })
    .catch(err => { if (!isMessageNotModified(err)) throw err })
}

/** sm:list, sm:s:<id>, sm:stop|main|ar|arok:<id>, sm:v:<id>:<0-2>, sm:n:<id>:<off|long|always> */
export async function handleSessionMenu(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^sm:([a-z]+)(?::([0-9a-f]+))?(?::(\w+))?$/.exec(data)
  if (!m) return false
  const [, action, id, value] = m
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await answer('Нет доступа.')
    return true
  }
  if (action === 'list') {
    await show(ctx, await sessionsList(d))
    await answer()
    return true
  }
  const s = id ? d.sessions.get(id) : undefined
  if (!s || s.passive) {
    await answer('Сессия уже отключена.')
    await show(ctx, await sessionsList(d))
    return true
  }
  let toast: string | undefined
  if (action === 'stop') {
    toast = stopSession(d, s) === 'interrupted' ? '⏹ Остановлено' : 'Сейчас нечего останавливать.'
  } else if (action === 'main') {
    d.store.set('main_dir', s.projectKey)
    toast = `👑 Главная → #${s.id}`
  } else if (action === 'ar' && s.topic) {
    await answer()
    const kb = new InlineKeyboard([[button('✅ Да, в архив', `sm:arok:${s.id}`, 'danger'), button('Отмена', `sm:s:${s.id}`)]])
    await show(ctx, { text: `Архивировать «${escapeHtml(s.topic.name)}»? Сессия #${s.id} будет закрыта, топик — закрыт.`, kb })
    return true
  } else if (action === 'arok' && s.topic) {
    const stuck = await archiveTopic(d, s.topic.chatId, s.topic.threadId)
    await answer()
    const text = stuck.length ? `🗄 Топик в архиве. Сессию #${s.id} закрыть не смог (не в tmux) — закройте её сами.` : `🗄 В архиве, сессия #${s.id} закрывается.`
    await show(ctx, { text, kb: new InlineKeyboard([[button('« К списку', 'sm:list')]]) })
    return true
  } else if (action === 'v' && ['0', '1', '2'].includes(value ?? '')) {
    const c = sessionChat(d, s)
    const v = Number(value) as 0 | 1 | 2
    setPref(c.threadId != null ? `${c.chatId}:${c.threadId}` : c.chatId, { verbose: v })
    toast = `Подробность: ${verboseBadge(v)}`
  } else if (action === 'n' && (value === 'off' || value === 'long' || value === 'always')) {
    const c = sessionChat(d, s)
    setPref(c.threadId != null ? `${c.chatId}:${c.threadId}` : c.chatId, { notifyDone: value })
    toast = `✅ готово: ${NOTIFY_DONE_INFO[value]}`
  }
  await show(ctx, await sessionScreen(d, s))
  await answer(toast)
  return true
}
