/**
 * /topics as a menu in one message, like /sessions: the project topics with
 * a button each; a button opens the topic with its sessions, queue and
 * actions (open, start a session, archive/restore, delete). With several
 * topics groups (FR-3) a row of buttons switches between them, and
 * «🗂 Группы топиков» sets each extra group's folders or disconnects it.
 *
 * Callback data: tm:list|arc[:<g>], tm:t|run|ar|arok|unar|del|delok:<thread>[:<g>],
 * tm:groups, tm:gp|gpath|goff|goffok:<g>[:<n>] — g is the group's index in
 * Daemon.topicChats() (0, the main one, is left out).
 */

import { InlineKeyboard, type Context } from 'grammy'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { can } from '../access.ts'
import { settings } from '../config.ts'
import type { TopicRow } from '../db.ts'
import { clip, escapeHtml } from '../format.ts'
import { topicLink } from '../tg.ts'
import type { Daemon } from './daemon.ts'
import { launchForTopic } from './launch.ts'
import { MAX_MESSAGE, show, type Btn, type Screen } from './menu.ts'
import { sessionLabel, statusLabel } from './report.ts'
import { button } from './stream.ts'
import { archiveTopic, deleteTopic, removeTopicGroup, sessionsOfTopic, unarchiveTopic } from './topics.ts'
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

/** ":<g>" for an extra group, "" for the main one. */
function gs(d: Daemon, chatId: string): string {
  const g = d.topicChats().indexOf(chatId)
  return g > 0 ? `:${g}` : ''
}

function groupTitle(d: Daemon, chatId: string): string {
  return chatId === d.topicsChatId ? tr('основная') : d.extraTopicGroups().find(g => g.chatId === chatId)?.title ?? chatId
}

/** Folders in PROJECTS_DIR an extra group can take. */
function folderChoices(): string[] {
  try {
    return readdirSync(settings.projectsDir).filter(n => !n.startsWith('.')).map(n => join(settings.projectsDir, n)).filter(p => statSync(p).isDirectory()).slice(0, 20)
  } catch {
    return []
  }
}

/** archived: show the archive instead of the working topics. */
export function topicsList(d: Daemon, chatId: string, archived = false): Screen {
  const rows = d.store.topics(chatId)
  const shown = rows.filter(t => (t.status === 'archived') === archived)
  const inArchive = rows.filter(t => t.status === 'archived').length
  const head = archived ? tr('🗄 <b>Архив топиков</b> ({length})', { length: shown.length }) : tr('📂 <b>Топики</b> · рабочих {length}, в архиве {inArchive}', { length: shown.length, inArchive })
  const lines = shown.map(t => `${archived ? '🗄' : '📁'} <b>${escapeHtml(plainName(t))}</b> · ${topicState(d, t)}`)
  const chats = d.topicChats()
  const groupHead = chats.length > 1 ? tr('Группа: <b>{title}</b>', { title: escapeHtml(groupTitle(d, chatId)) }) : ''
  let text = [head, ...(groupHead ? [groupHead] : []), lines.length ? tr('{v}\n\nВыберите топик:', { v: lines.join('\n') }) : archived ? tr('Архив пуст.') : tr('Топиков проектов нет.')].join('\n\n')
  if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE - 1) + '…'

  const kb: Btn[][] = []
  for (const [i, t] of shown.slice(0, 40).entries()) {
    const b = button(clip(`${archived ? '🗄' : '📁'} ${plainName(t)}`, 40), `tm:t:${t.thread_id}${gs(d, chatId)}`)
    if (i % 2 === 0) kb.push([b])
    else kb.at(-1)!.push(b)
  }
  const g = gs(d, chatId)
  if (chats.length > 1) {
    kb.push(chats.slice(0, 4).map((c, i) => button(clip(`${c === chatId ? '• ' : ''}${groupTitle(d, c)}`, 24), `tm:list${i ? `:${i}` : ''}`, c === chatId ? 'primary' : undefined)))
  }
  kb.push(archived
    ? [button(tr('« Рабочие топики'), `tm:list${g}`)]
    : [...(inArchive ? [button(tr('🗄 Архив ({inArchive})', { inArchive }), `tm:arc${g}`)] : []), button(tr('🔄 Обновить'), `tm:list${g}`)])
  kb.push([button(tr('🗂 Группы топиков'), 'tm:groups'), button(tr('« Меню'), 'hub:main')])
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
  const g = gs(d, t.chat_id)
  if (link) first.push(InlineKeyboard.url(tr('💬 Открыть'), link))
  for (const s of live.slice(0, 2)) first.push(button(tr('📋 Сессия #{id}', { id: s.id }), `sm:s:${s.id}`))
  if (!live.length && !archived && t.project_key && !t.project_key.includes('#')) first.push(button(tr('🚀 Запустить сессию'), `tm:run:${t.thread_id}${g}`, 'success'))
  if (first.length) kb.push(first)
  kb.push(archived
    ? [button(tr('↩️ Восстановить'), `tm:unar:${t.thread_id}${g}`), button(tr('🗑 Удалить'), `tm:del:${t.thread_id}${g}`, 'danger')]
    : [button(tr('🗄 В архив'), `tm:ar:${t.thread_id}${g}`), button(tr('🗑 Удалить'), `tm:del:${t.thread_id}`, 'danger')])
  kb.push([button(tr('« К списку'), archived ? `tm:arc${g}` : `tm:list${g}`), button('🔄', `tm:t:${t.thread_id}${g}`)])
  return { text: lines.join('\n'), kb: new InlineKeyboard(kb as never) }
}

/** «🗂 Группы топиков»: the main group and the extra ones with their folders. */
export function groupsOfTopicsScreen(d: Daemon): Screen {
  const extra = d.extraTopicGroups()
  const lines = [tr('🗂 <b>Группы топиков</b>'), tr('Основная: {title} — General, пульт и все проекты, которые не взяли другие группы.', { title: escapeHtml(d.topicsChatId ?? '—') })]
  const kb: Btn[][] = []
  for (const [i, g] of extra.entries()) {
    lines.push('', `📂 <b>${escapeHtml(g.title)}</b> (<code>${escapeHtml(g.chatId)}</code>)`, g.paths.length ? g.paths.map(p => `   • <code>${escapeHtml(p)}</code>`).join('\n') : tr('   папки не заданы — только топики, созданные в ней'))
    kb.push([button(clip(tr('📁 Папки: {title}', { title: g.title }), 40), `tm:gp:${i + 1}`), button(tr('🔌 Отключить'), `tm:goff:${i + 1}`, 'danger')])
  }
  lines.push('', tr('Ещё группу: /connect_group в личке с ботом — если основная уже есть, новая станет дополнительной.'))
  kb.push([button(tr('« Топики'), 'tm:list')])
  return { text: lines.join('\n'), kb: new InlineKeyboard(kb as never) }
}

function groupPathsScreen(d: Daemon, gi: number): Screen {
  const g = d.extraTopicGroups()[gi - 1]
  const dirs = folderChoices()
  const kb: Btn[][] = dirs.map((p, n) => [button(clip(`${g.paths.includes(p) ? '✅' : '⬜️'} ${p.replace(process.env.HOME ?? '\0', '~')}`, 40), `tm:gpath:${gi}:${n}`)])
  kb.push([button(tr('« Группы топиков'), 'tm:groups')])
  return {
    text: tr('📁 Папки группы <b>{title}</b>: проекты внутри отмеченных папок получат топик в этой группе.', { title: escapeHtml(g.title) }) + (dirs.length ? '' : '\n\n' + tr('В {dir} пока нет папок проектов.', { dir: settings.projectsDir })),
    kb: new InlineKeyboard(kb as never),
  }
}

export async function handleTopicMenu(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^tm:([a-z]+)(?::(\d+))?(?::(\d+))?$/.exec(data)
  if (!m) return false
  const [, action, arg, arg2] = m
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || !can(ctx.from.id, 'control')) {
    await answer(tr('Нет доступа.'))
    return true
  }
  if (action === 'groups') {
    await answer()
    await show(ctx, groupsOfTopicsScreen(d))
    return true
  }
  if (['gp', 'gpath', 'goff', 'goffok'].includes(action)) {
    const gi = Number(arg)
    const groups = d.extraTopicGroups()
    const g = groups[gi - 1]
    if (!g) { await answer(tr('Группа не найдена.')); await show(ctx, groupsOfTopicsScreen(d)); return true }
    if (action === 'gpath') {
      const p = folderChoices()[Number(arg2)]
      if (p) {
        g.paths = g.paths.includes(p) ? g.paths.filter(x => x !== p) : [...g.paths, p]
        d.setExtraTopicGroups(groups)
      }
    }
    if (action === 'goff') {
      await answer()
      await show(ctx, { text: tr('Отключить группу топиков <b>{title}</b>? Её топики останутся в Telegram, новые проекты пойдут в основную группу.', { title: escapeHtml(g.title) }), kb: new InlineKeyboard([[button(tr('🔌 Да, отключить'), `tm:goffok:${gi}`, 'danger'), button(tr('Отмена'), 'tm:groups')]]) })
      return true
    }
    if (action === 'goffok') {
      removeTopicGroup(d, g.chatId)
      await answer(tr('🔌 Отключена'))
      await show(ctx, groupsOfTopicsScreen(d))
      return true
    }
    await answer()
    await show(ctx, groupPathsScreen(d, gi))
    return true
  }
  const chats = d.topicChats()
  const listAction = action === 'list' || action === 'arc'
  const chat = chats[Number(listAction ? arg ?? 0 : arg2 ?? 0)] ?? d.topicsChatId
  if (!chat) { await answer(tr('Группа не подключена.')); return true }
  if (listAction) {
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
    await show(ctx, { text: question, kb: new InlineKeyboard([[button(label, yes, 'danger'), button(tr('Отмена'), `tm:t:${thread}${gs(d, chat)}`)]]) })
  }
  let toast: string | undefined
  if (action === 'run' && t.project_key) {
    void launchForTopic(d, chat, thread, t.project_key).catch(err => d.log(`topic launch failed: ${err}`))
    toast = tr('🚀 Запускаю — подтверждение придёт в топик')
  } else if (action === 'ar') {
    const live = sessionsOfTopic(d, chat, thread)
    await confirm(tr('Архивировать «{v}»?{v2} Топик закроется.', { v: escapeHtml(plainName(t)), v2: live.length ? tr(' Сессии {v} будут закрыты.', { v: live.map(s => `#${s.id}`).join(', ') }) : '' }), `tm:arok:${thread}${gs(d, chat)}`, tr('✅ Да, в архив'))
    return true
  } else if (action === 'arok') {
    const stuck = await archiveTopic(d, chat, thread)
    toast = stuck.length ? tr('🗄 В архиве. Часть сессий не в tmux — закройте их сами.') : tr('🗄 В архиве')
  } else if (action === 'unar') {
    await unarchiveTopic(d, chat, thread, { launch: settings.topicProjects !== 'off' })
    toast = tr('↩️ Восстановлен')
  } else if (action === 'del') {
    await confirm(tr('Удалить топик «{v}» вместе со всеми сообщениями? Это не отменить.', { v: escapeHtml(plainName(t)) }), `tm:delok:${thread}${gs(d, chat)}`, tr('🗑 Да, удалить'))
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
