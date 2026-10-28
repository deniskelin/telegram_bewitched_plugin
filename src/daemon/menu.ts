/**
 * /sessions as a menu in one message, like BotFather: the list of sessions
 * with a button each; a button opens the session's card with its actions and
 * the progress settings of its chat; « Назад returns to the list.
 */

import { InlineKeyboard, InputFile, type Context } from 'grammy'
import { isOwner, NOTIFY_DONE_INFO, owner, prefsFor, setPref, verboseBadge } from '../access.ts'
import { settings } from '../config.ts'
import { escapeHtml } from '../format.ts'
import { isMessageNotModified, topicLink } from '../tg.ts'
import type { Daemon, Session } from './daemon.ts'
import { gitDiff, gitInfo } from './git.ts'
import { stopSession } from './inbound.ts'
import { footer, passiveBlock, sessionCard, sessionChat, sessionLabel, sortedSessions, statusLabel } from './report.ts'
import { button } from './stream.ts'
import { archiveTopic, sessionTarget } from './topics.ts'
import { transcriptInfo } from './transcript.ts'

export const MAX_MESSAGE = 4000
export type Screen = { text: string; kb: InlineKeyboard }
export type Btn = ReturnType<typeof button> | ReturnType<typeof InlineKeyboard.url>

export async function sessionsList(d: Daemon): Promise<Screen> {
  const list = sortedSessions(d)
  const lines = list.map(s => {
    const label = sessionLabel(d, s)
    const icon = label.slice(0, label.indexOf(' '))
    return `${icon} <b>${escapeHtml(label.slice(icon.length + 1))}</b> · ${statusLabel(s)}${s.topic ? ` · 💬 ${escapeHtml(s.topic.name)}` : ''}`
  })
  const blocks = [`📋 <b>Сессии</b> (${list.length})`, lines.length ? `${lines.join('\n')}\n\nВыберите сессию:` : 'Нет запущенных сессий.']
  if (d.permissions.size) blocks.push(`🔐 Ждут разрешения: ${d.permissions.size} — /permissions`)
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
  rows.push([...(d.permissions.size ? [button(`🔐 Разрешения (${d.permissions.size})`, 'sm:perms')] : []), button('👥 Пригласить', 'inv:start'), button('🔄 Обновить', 'sm:list')])
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
  const user = d.userIdOf(s)
  if (user && user !== owner()) rows.push([button('🚫 Удалить пользователя', `ur:ask:${user}`, 'danger')])
  const look: Btn[] = []
  if (s.tmuxPane && /^%\d+$/.test(s.tmuxPane)) look.push(button('👁 Экран и клавиши', `tx:p${s.tmuxPane.slice(1)}`))
  if (s.branch) look.push(button('🌿 Git', `sm:git:${s.id}`))
  if (look.length) rows.push(look)
  if (s.alwaysAllow.size) rows.push([button('♾ Снова спрашивать разрешения', `sm:aar:${s.id}`)])
  if (s.tmuxPane) rows.push([button('🧹 /compact', `sm:cmp:${s.id}`), button('🆕 /clear', `sm:clr:${s.id}`), button('🧠 Модель', `sm:mdl:${s.id}`)])
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

/** Claude Code models offered in 🧠 Модель: /model takes the id. */
const MODELS: [string, string][] = [['opus', 'claude-opus-5-5'], ['sonnet', 'claude-sonnet-5-5'], ['haiku', 'claude-haiku-5-5'], ['fable', 'claude-fable-5-1']]

/**
 * /compact, /clear (asked first) and /model typed into the session's pane.
 * Only between turns: typed mid-turn they would land in the prompt queue.
 */
async function controlAction(d: Daemon, s: Session, action: string, value: string | undefined): Promise<{ toast?: string; screen?: Screen; sent?: boolean }> {
  if (!s.tmuxPane) return { toast: 'Сессия не в tmux — команды не отправить.' }
  if (action === 'mdl') {
    const rows = MODELS.map(([alias, id]) => [button(`🧠 ${id.replace(/^claude-/, '')}`, `sm:model:${s.id}:${alias}`)])
    rows.push([button('« Назад', `sm:s:${s.id}`)])
    return { screen: { text: `🧠 Модель для сессии #${s.id} (${escapeHtml(s.projectName)}). Команда <code>/model</code> уйдёт в её окно tmux.`, kb: new InlineKeyboard(rows) } }
  }
  if (action === 'clr') {
    const kb = new InlineKeyboard([[button('✅ Да, /clear', `sm:clrok:${s.id}`, 'danger'), button('Отмена', `sm:s:${s.id}`)]])
    return { screen: { text: `Очистить разговор сессии #${s.id} (${escapeHtml(s.projectName)})? Контекст начнётся заново, транскрипт останется для <code>--resume</code>.`, kb } }
  }
  if (s.turn || s.status !== 'idle') return { toast: 'Сессия работает — дождитесь конца хода или нажмите ⏹.' }
  const line = action === 'cmp' ? '/compact' : action === 'clrok' ? '/clear' : `/model ${MODELS.find(([a]) => a === value)?.[1] ?? ''}`
  if (line === '/model ') return { toast: 'Неизвестная модель.' }
  await d.tmuxType(s.tmuxPane, line)
  if (action === 'clrok') s.contextWarned = false
  return { toast: `➡️ ${line}`, sent: true }
}

async function gitScreen(s: Session): Promise<Screen> {
  const back = [button('« Назад', `sm:s:${s.id}`), button('🔄', `sm:git:${s.id}`)]
  const g = await gitInfo(s.cwd)
  if (!g) return { text: `🌿 <code>${escapeHtml(s.cwd)}</code> — не git-репозиторий.`, kb: new InlineKeyboard([back]) }
  const parts = [`🌿 <b>Git</b> · ${escapeHtml(s.projectName)}`, `<pre>${escapeHtml(g.status)}</pre>`]
  if (g.log) parts.push(`Последние коммиты:\n<pre>${escapeHtml(g.log)}</pre>`)
  if (g.pr) parts.push(`🔀 PR <a href="${escapeHtml(g.pr.url)}">#${g.pr.number}</a> · ${escapeHtml(g.pr.state.toLowerCase())} · ${escapeHtml(g.pr.title)}`)
  let text = parts.join('\n')
  if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE - 1) + '…'
  const rows: Btn[][] = [[button('📄 diff файлом', `sm:gdf:${s.id}`)]]
  if (g.pr) rows[0].push(InlineKeyboard.url(`🔀 PR #${g.pr.number}`, g.pr.url))
  rows.push(back)
  return { text, kb: new InlineKeyboard(rows as never) }
}

export async function show(ctx: Context, sc: Screen): Promise<void> {
  await ctx.editMessageText(sc.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: sc.kb })
    .catch(err => { if (!isMessageNotModified(err)) throw err })
}

/** sm:list, sm:s:<id>, sm:stop|main|ar|arok|cmp|cmpn|clr|clrok|mdl:<id>, sm:model:<id>:<alias>, sm:v:<id>:<0-2>, sm:n:<id>:<off|long|always> */
export async function handleSessionMenu(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^sm:([a-z]+)(?::([0-9a-f]+))?(?::(\w+))?$/.exec(data)
  if (!m) return false
  const [, action, id, value] = m
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await answer('Нет доступа.')
    return true
  }
  if (action === 'perms') {
    await answer()
    await show(ctx, permissionsScreen(d))
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
  if (action === 'git') {
    await answer()
    await show(ctx, await gitScreen(s))
    return true
  }
  if (action === 'gdf') {
    const diff = await gitDiff(s.cwd)
    if (diff == null) { await answer('Не удалось получить diff.'); return true }
    if (!diff.trim()) { await answer('Изменений нет: рабочее дерево чистое.'); return true }
    await answer('📄 Отправляю diff')
    const name = `${s.projectName}${s.branch ? `-${s.branch.replace(/[^\w.-]+/g, '_')}` : ''}.diff`
    const thread = ctx.callbackQuery?.message?.message_thread_id
    await ctx.replyWithDocument(new InputFile(Buffer.from(diff), name), {
      caption: `📄 git diff HEAD · ${s.projectName} · ${diff.split('\n').filter(l => /^diff --git/.test(l)).length} файл(ов)`,
      ...(thread ? { message_thread_id: thread } : {}),
    })
    return true
  }
  if (action === 'cmpn') {
    // The button under a "context is filling up" notice: keep the notice, drop the button.
    const r = await controlAction(d, s, 'cmp', undefined)
    await answer(r.toast)
    if (r.sent) await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
    return true
  }
  if (['cmp', 'clr', 'clrok', 'mdl', 'model'].includes(action)) {
    const r = await controlAction(d, s, action, value)
    if (r.screen) {
      await answer()
      await show(ctx, r.screen)
      return true
    }
    toast = r.toast
  } else if (action === 'aar') {
    s.alwaysAllow.clear()
    toast = '🔐 Разрешения снова спрашиваются'
  } else if (action === 'stop') {
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

/**
 * After a turn: once the context passes CONTEXT_WARN_PCT, offer /compact in
 * the session's chat. Once per filling; the flag resets when it shrinks.
 */
export async function checkContext(d: Daemon, s: Session): Promise<void> {
  const pct = settings.contextWarnPct
  if (pct <= 0 || !s.tmuxPane) return
  const transcript = s.claude.transcript
  const tr = transcript ? await transcriptInfo(transcript) : null
  if (tr?.tokens == null) return
  const fill = (tr.tokens / settings.contextWindow) * 100
  if (fill < pct) { s.contextWarned = false; return }
  if (s.contextWarned || fill > 100) return
  const target = sessionTarget(d, s)
  if (!target) return
  s.contextWarned = true
  const text = `🧠 Контекст сессии ${escapeHtml(sessionLabel(d, s))} (#${s.id}) заполнен на <b>${Math.round(fill)}%</b>. Сжать разговор?`
  await d.bot.api.sendMessage(target.chatId, text, {
    parse_mode: 'HTML',
    ...(target.threadId != null ? { message_thread_id: target.threadId } : {}),
    reply_markup: new InlineKeyboard([[button('🧹 /compact', `sm:cmpn:${s.id}`, 'primary')]]),
  }).catch(err => d.log(`context notice failed: ${err}`))
}

/** Every permission request still waiting, across sessions, with buttons to answer each. */
export function permissionsScreen(d: Daemon): Screen {
  const items = [...d.permissions.entries()]
  const rows: Btn[][] = []
  const lines = [`🔐 <b>Ждут разрешения</b> (${items.length})`]
  for (const [rid, p] of items.slice(0, 15)) {
    const s = d.sessions.get(p.sessionId)
    const who = s ? sessionLabel(d, s) : `#${p.sessionId}`
    const desc = p.description.length > 80 ? p.description.slice(0, 79) + '…' : p.description
    lines.push(`• ${escapeHtml(who)} · <b>${escapeHtml(p.tool_name)}</b>${desc ? ` — ${escapeHtml(desc)}` : ''}`)
    rows.push([button(`✅ ${p.tool_name} · ${who}`.slice(0, 40), `perm:allow:${rid}`, 'success'), button('❌', `perm:deny:${rid}`, 'danger')])
  }
  if (!items.length) lines.push('Ничего не ждёт.')
  rows.push([button('« К сессиям', 'sm:list'), button('🔄', 'sm:perms')])
  return { text: lines.join('\n'), kb: new InlineKeyboard(rows as never) }
}
