/**
 * /topics as a menu in one message, like /sessions: the project topics with
 * a button each; a button opens the topic with its sessions, queue and
 * actions (open, start a session, archive/restore, delete).
 */

import { InlineKeyboard, type Context } from 'grammy'
import { isOwner } from '../access.ts'
import { settings } from '../config.ts'
import type { TopicRow } from '../db.ts'
import { clip, escapeHtml } from '../format.ts'
import { topicLink } from '../tg.ts'
import type { Daemon } from './daemon.ts'
import { launchForTopic } from './launch.ts'
import { MAX_MESSAGE, show, type Btn, type Screen } from './menu.ts'
import { sessionLabel, statusLabel } from './report.ts'
import { button } from './stream.ts'
import { archiveTopic, deleteTopic, sessionsOfTopic, unarchiveTopic } from './topics.ts'

const ARCHIVE_PREFIX = '🗄 '

function topicState(d: Daemon, t: TopicRow): string {
  if (t.status === 'archived') return '🗄 в архиве'
  const live = sessionsOfTopic(d, t.chat_id, t.thread_id)
  if (live.length) return live.map(s => `${statusLabel(s)} #${s.id}`).join(', ')
  const n = t.project_key ? d.store.pendingCount(t.project_key, settings.pendingTtlH) : 0
  return `💤 без сессии${n ? ` · в очереди ${n}` : ''}`
}

const plainName = (t: TopicRow) => t.name.replace(ARCHIVE_PREFIX, '')

/** archived: show the archive instead of the working topics. */
export function topicsList(d: Daemon, chatId: string, archived = false): Screen {
  const rows = d.store.topics(chatId)
  const shown = rows.filter(t => (t.status === 'archived') === archived)
  const inArchive = rows.filter(t => t.status === 'archived').length
  const head = archived ? `🗄 <b>Архив топиков</b> (${shown.length})` : `📂 <b>Топики</b> · рабочих ${shown.length}, в архиве ${inArchive}`
  const lines = shown.map(t => `${archived ? '🗄' : '📁'} <b>${escapeHtml(plainName(t))}</b> · ${topicState(d, t)}`)
  let text = [head, lines.length ? `${lines.join('\n')}\n\nВыберите топик:` : archived ? 'Архив пуст.' : 'Топиков проектов нет.'].join('\n\n')
  if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE - 1) + '…'

  const kb: Btn[][] = []
  for (const [i, t] of shown.slice(0, 40).entries()) {
    const b = button(clip(`${archived ? '🗄' : '📁'} ${plainName(t)}`, 40), `tm:t:${t.thread_id}`)
    if (i % 2 === 0) kb.push([b])
    else kb.at(-1)!.push(b)
  }
  kb.push(archived
    ? [button('« Рабочие топики', 'tm:list')]
    : [...(inArchive ? [button(`🗄 Архив (${inArchive})`, 'tm:arc')] : []), button('🔄 Обновить', 'tm:list'), button('« Меню', 'hub:main')])
  return { text, kb: new InlineKeyboard(kb as never) }
}

export function topicScreen(d: Daemon, t: TopicRow): Screen {
  const live = sessionsOfTopic(d, t.chat_id, t.thread_id)
  const link = topicLink(t.chat_id, t.thread_id)
  const archived = t.status === 'archived'
  const lines = [`${archived ? '🗄' : '📁'} <b>${escapeHtml(plainName(t))}</b>`]
  lines.push(t.project_key ? `📁 <code>${escapeHtml(t.project_key)}</code>` : 'не привязан к проекту')
  lines.push(`Состояние: ${topicState(d, t)}${t.status === 'waiting' ? ' · топик закрыт до подключения сессии' : ''}`)
  for (const s of live) lines.push(`${sessionLabel(d, s)} · ${statusLabel(s)} · #${s.id}`)
  lines.push(`Активность: ${new Date(t.last_activity_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`)

  const kb: Btn[][] = []
  const first: Btn[] = []
  if (link) first.push(InlineKeyboard.url('💬 Открыть', link))
  for (const s of live.slice(0, 2)) first.push(button(`📋 Сессия #${s.id}`, `sm:s:${s.id}`))
  if (!live.length && !archived && t.project_key && !t.project_key.includes('#')) first.push(button('🚀 Запустить сессию', `tm:run:${t.thread_id}`, 'success'))
  if (first.length) kb.push(first)
  kb.push(archived
    ? [button('↩️ Восстановить', `tm:unar:${t.thread_id}`), button('🗑 Удалить', `tm:del:${t.thread_id}`, 'danger')]
    : [button('🗄 В архив', `tm:ar:${t.thread_id}`), button('🗑 Удалить', `tm:del:${t.thread_id}`, 'danger')])
  kb.push([button('« К списку', archived ? 'tm:arc' : 'tm:list'), button('🔄', `tm:t:${t.thread_id}`)])
  return { text: lines.join('\n'), kb: new InlineKeyboard(kb as never) }
}

/** tm:list, tm:arc, tm:t|run|ar|arok|unar|del|delok:<thread> */
export async function handleTopicMenu(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^tm:([a-z]+)(?::(\d+))?$/.exec(data)
  if (!m) return false
  const [, action, arg] = m
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await answer('Нет доступа.')
    return true
  }
  const chat = d.topicsChatId
  if (!chat) { await answer('Группа не подключена.'); return true }
  if (action === 'list' || action === 'arc') {
    await answer()
    await show(ctx, topicsList(d, chat, action === 'arc'))
    return true
  }
  const thread = Number(arg)
  const t = d.store.topic(chat, thread)
  if (!t) {
    await answer('Топик не найден.')
    await show(ctx, topicsList(d, chat))
    return true
  }
  const confirm = async (question: string, yes: string, label: string) => {
    await answer()
    await show(ctx, { text: question, kb: new InlineKeyboard([[button(label, yes, 'danger'), button('Отмена', `tm:t:${thread}`)]]) })
  }
  let toast: string | undefined
  if (action === 'run' && t.project_key) {
    void launchForTopic(d, chat, thread, t.project_key).catch(err => d.log(`topic launch failed: ${err}`))
    toast = '🚀 Запускаю — подтверждение придёт в топик'
  } else if (action === 'ar') {
    const live = sessionsOfTopic(d, chat, thread)
    await confirm(`Архивировать «${escapeHtml(plainName(t))}»?${live.length ? ` Сессии ${live.map(s => `#${s.id}`).join(', ')} будут закрыты.` : ''} Топик закроется.`, `tm:arok:${thread}`, '✅ Да, в архив')
    return true
  } else if (action === 'arok') {
    const stuck = await archiveTopic(d, chat, thread)
    toast = stuck.length ? '🗄 В архиве. Часть сессий не в tmux — закройте их сами.' : '🗄 В архиве'
  } else if (action === 'unar') {
    await unarchiveTopic(d, chat, thread, { launch: settings.topicProjects !== 'off' })
    toast = '↩️ Восстановлен'
  } else if (action === 'del') {
    await confirm(`Удалить топик «${escapeHtml(plainName(t))}» вместе со всеми сообщениями? Это не отменить.`, `tm:delok:${thread}`, '🗑 Да, удалить')
    return true
  } else if (action === 'delok') {
    await deleteTopic(d, chat, thread)
    await answer('🗑 Удалён')
    await show(ctx, topicsList(d, chat))
    return true
  }
  const fresh = d.store.topic(chat, thread)
  await show(ctx, fresh ? topicScreen(d, fresh) : topicsList(d, chat))
  await answer(toast)
  return true
}
