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
import { locale, t as tr } from '../i18n/index.ts'

const ARCHIVE_PREFIX = '🗄 '

function topicState(d: Daemon, t: TopicRow): string {
  if (t.status === 'archived') return tr('🗄 в архиве')
  const live = sessionsOfTopic(d, t.chat_id, t.thread_id)
  if (live.length) return live.map(s => `${statusLabel(s)} #${s.id}`).join(', ')
  const n = t.project_key ? d.store.pendingCount(t.project_key, settings.pendingTtlH) : 0
  return tr('💤 без сессии{v}', { v: n ? tr(' · в очереди {n}', { n }) : '' })
}

const plainName = (t: TopicRow) => t.name.replace(ARCHIVE_PREFIX, '')

/** archived: show the archive instead of the working topics. */
export function topicsList(d: Daemon, chatId: string, archived = false): Screen {
  const rows = d.store.topics(chatId)
  const shown = rows.filter(t => (t.status === 'archived') === archived)
  const inArchive = rows.filter(t => t.status === 'archived').length
  const head = archived ? tr('🗄 <b>Архив топиков</b> ({length})', { length: shown.length }) : tr('📂 <b>Топики</b> · рабочих {length}, в архиве {inArchive}', { length: shown.length, inArchive })
  const lines = shown.map(t => `${archived ? '🗄' : '📁'} <b>${escapeHtml(plainName(t))}</b> · ${topicState(d, t)}`)
  let text = [head, lines.length ? tr('{v}\n\nВыберите топик:', { v: lines.join('\n') }) : archived ? tr('Архив пуст.') : tr('Топиков проектов нет.')].join('\n\n')
  if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE - 1) + '…'

  const kb: Btn[][] = []
  for (const [i, t] of shown.slice(0, 40).entries()) {
    const b = button(clip(`${archived ? '🗄' : '📁'} ${plainName(t)}`, 40), `tm:t:${t.thread_id}`)
    if (i % 2 === 0) kb.push([b])
    else kb.at(-1)!.push(b)
  }
  kb.push(archived
    ? [button(tr('« Рабочие топики'), 'tm:list')]
    : [...(inArchive ? [button(tr('🗄 Архив ({inArchive})', { inArchive }), 'tm:arc')] : []), button(tr('🔄 Обновить'), 'tm:list'), button(tr('« Меню'), 'hub:main')])
  return { text, kb: new InlineKeyboard(kb as never) }
}

export function topicScreen(d: Daemon, t: TopicRow): Screen {
  const live = sessionsOfTopic(d, t.chat_id, t.thread_id)
  const link = topicLink(t.chat_id, t.thread_id)
  const archived = t.status === 'archived'
  const lines = [`${archived ? '🗄' : '📁'} <b>${escapeHtml(plainName(t))}</b>`]
  lines.push(t.project_key ? `📁 <code>${escapeHtml(t.project_key)}</code>` : tr('не привязан к проекту'))
  lines.push(tr('Состояние: {v}{v2}', { v: topicState(d, t), v2: t.status === 'waiting' ? tr(' · топик закрыт до подключения сессии') : '' }))
  for (const s of live) lines.push(`${sessionLabel(d, s)} · ${statusLabel(s)} · #${s.id}`)
  lines.push(tr('Активность: {v}', { v: new Date(t.last_activity_at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }))

  const kb: Btn[][] = []
  const first: Btn[] = []
  if (link) first.push(InlineKeyboard.url(tr('💬 Открыть'), link))
  for (const s of live.slice(0, 2)) first.push(button(tr('📋 Сессия #{id}', { id: s.id }), `sm:s:${s.id}`))
  if (!live.length && !archived && t.project_key && !t.project_key.includes('#')) first.push(button(tr('🚀 Запустить сессию'), `tm:run:${t.thread_id}`, 'success'))
  if (first.length) kb.push(first)
  kb.push(archived
    ? [button(tr('↩️ Восстановить'), `tm:unar:${t.thread_id}`), button(tr('🗑 Удалить'), `tm:del:${t.thread_id}`, 'danger')]
    : [button(tr('🗄 В архив'), `tm:ar:${t.thread_id}`), button(tr('🗑 Удалить'), `tm:del:${t.thread_id}`, 'danger')])
  kb.push([button(tr('« К списку'), archived ? 'tm:arc' : 'tm:list'), button('🔄', `tm:t:${t.thread_id}`)])
  return { text: lines.join('\n'), kb: new InlineKeyboard(kb as never) }
}

/** tm:list, tm:arc, tm:t|run|ar|arok|unar|del|delok:<thread> */
export async function handleTopicMenu(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^tm:([a-z]+)(?::(\d+))?$/.exec(data)
  if (!m) return false
  const [, action, arg] = m
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await answer(tr('Нет доступа.'))
    return true
  }
  const chat = d.topicsChatId
  if (!chat) { await answer(tr('Группа не подключена.')); return true }
  if (action === 'list' || action === 'arc') {
    await answer()
    await show(ctx, topicsList(d, chat, action === 'arc'))
    return true
  }
  const thread = Number(arg)
  const t = d.store.topic(chat, thread)
  if (!t) {
    await answer(tr('Топик не найден.'))
    await show(ctx, topicsList(d, chat))
    return true
  }
  const confirm = async (question: string, yes: string, label: string) => {
    await answer()
    await show(ctx, { text: question, kb: new InlineKeyboard([[button(label, yes, 'danger'), button(tr('Отмена'), `tm:t:${thread}`)]]) })
  }
  let toast: string | undefined
  if (action === 'run' && t.project_key) {
    void launchForTopic(d, chat, thread, t.project_key).catch(err => d.log(`topic launch failed: ${err}`))
    toast = tr('🚀 Запускаю — подтверждение придёт в топик')
  } else if (action === 'ar') {
    const live = sessionsOfTopic(d, chat, thread)
    await confirm(tr('Архивировать «{v}»?{v2} Топик закроется.', { v: escapeHtml(plainName(t)), v2: live.length ? tr(' Сессии {v} будут закрыты.', { v: live.map(s => `#${s.id}`).join(', ') }) : '' }), `tm:arok:${thread}`, tr('✅ Да, в архив'))
    return true
  } else if (action === 'arok') {
    const stuck = await archiveTopic(d, chat, thread)
    toast = stuck.length ? tr('🗄 В архиве. Часть сессий не в tmux — закройте их сами.') : tr('🗄 В архиве')
  } else if (action === 'unar') {
    await unarchiveTopic(d, chat, thread, { launch: settings.topicProjects !== 'off' })
    toast = tr('↩️ Восстановлен')
  } else if (action === 'del') {
    await confirm(tr('Удалить топик «{v}» вместе со всеми сообщениями? Это не отменить.', { v: escapeHtml(plainName(t)) }), `tm:delok:${thread}`, tr('🗑 Да, удалить'))
    return true
  } else if (action === 'delok') {
    await deleteTopic(d, chat, thread)
    await answer(tr('🗑 Удалён'))
    await show(ctx, topicsList(d, chat))
    return true
  }
  const fresh = d.store.topic(chat, thread)
  await show(ctx, fresh ? topicScreen(d, fresh) : topicsList(d, chat))
  await answer(toast)
  return true
}
