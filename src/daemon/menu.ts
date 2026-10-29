/**
 * /sessions as a menu in one message, like BotFather: the list of sessions
 * with a button each; a button opens the session's card with its actions and
 * the progress settings of its chat; « Назад returns to the list.
 */

import { InlineKeyboard, InputFile, type Context } from 'grammy'
import { can, NOTIFY_DONE_INFO, owner, prefsFor, setPref, verboseBadge } from '../access.ts'
import { settings } from '../config.ts'
import { clip, escapeHtml } from '../format.ts'
import { locale, t } from '../i18n/index.ts'
import { isMessageNotModified, topicLink } from '../tg.ts'
import type { Daemon, Session } from './daemon.ts'
import { gitDiff, gitInfo } from './git.ts'
import { stopSession } from './inbound.ts'
import { footer, passiveBlock, sessionCard, sessionChat, projectTitle, sessionLabel, sessionShortName, sortedSessions, statusLabel } from './report.ts'
import { button } from './stream.ts'
import { archiveTopic, sessionTarget } from './topics.ts'
import { projectRules, removeProjectRule } from './permrules.ts'
import { listConversations, transcriptInfo } from './transcript.ts'

export const MAX_MESSAGE = 4000
export type Screen = { text: string; kb: InlineKeyboard }
export type Btn = ReturnType<typeof button> | ReturnType<typeof InlineKeyboard.url>

export async function sessionsList(d: Daemon): Promise<Screen> {
  const list = sortedSessions(d)
  const lines = list.map((s, i) => {
    const label = sessionLabel(d, s)
    const icon = label.slice(0, label.indexOf(' '))
    return `${i + 1}. ${icon} <b>${escapeHtml(label.slice(icon.length + 1))}</b> · ${statusLabel(s)}${s.group ? ' · 👥' : ''}`
  })
  const blocks = [t('📋 <b>Сессии</b> ({length})', { length: list.length }), lines.length ? `${lines.join('\n')}\n\n${t('Выберите сессию:')}` : t('Нет запущенных сессий.')]
  if (d.permissions.size) blocks.push(t('🔐 Ждут разрешения: {size} — /permissions', { size: d.permissions.size }))
  const passive = await passiveBlock(d)
  if (passive) blocks.push(passive)
  blocks.push(footer(d))
  let text = blocks.join('\n\n')
  if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE - 1) + '…'

  const rows: Btn[][] = []
  for (const [i, s] of list.entries()) {
    // The number from the list, the name and the status dot: the rest is in the text above.
    const b = button(`${i + 1}. ${clip(sessionShortName(d, s), 30)} ${statusLabel(s).slice(0, 2)}`, `sm:s:${s.id}`)
    if (i % 2 === 0) rows.push([b])
    else rows.at(-1)!.push(b)
  }
  rows.push([...(d.permissions.size ? [button(t('🔐 Разрешения ({size})', { size: d.permissions.size }), 'sm:perms')] : []), button(t('👥 Пригласить'), 'inv:start'), button(t('🔄 Обновить'), 'sm:list')])
  rows.push([button(t('« Меню'), 'hub:main')])
  return { text, kb: new InlineKeyboard(rows as never) }
}

export async function sessionScreen(d: Daemon, s: Session): Promise<Screen> {
  const c = sessionChat(d, s)
  const p = prefsFor(c.chatId, c.threadId)
  const rows: Btn[][] = []

  const actions: Btn[] = []
  if (s.tmuxPane && s.status === 'working') actions.push(button(t('⏹ Стоп'), `sm:stop:${s.id}`, 'danger'))
  if (s !== d.mainSession() && !d.userIdOf(s)) actions.push(button(t('👑 Сделать главной'), `sm:main:${s.id}`))
  if (s.topic) actions.push(button(t('🗄 В архив'), `sm:ar:${s.id}`))
  if (s.group) actions.push(button(t('👥 Отвязать группу'), `gp:unbind:${s.group.chatId}`, 'danger'))
  if (actions.length) rows.push(actions)
  const user = d.userIdOf(s)
  if (user && user !== owner()) rows.push([button(t('🚫 Удалить пользователя'), `ur:ask:${user}`, 'danger')])
  const look: Btn[] = []
  if (s.tmuxPane && /^%\d+$/.test(s.tmuxPane)) look.push(button(t('👁 Экран и клавиши'), `tx:p${s.tmuxPane.slice(1)}`))
  if (s.branch) look.push(button('🌿 Git', `sm:git:${s.id}`))
  if (look.length) rows.push(look)
  const perms: Btn[] = []
  if (s.alwaysAllow.size) perms.push(button(t('♾ Снова спрашивать'), `sm:aar:${s.id}`))
  if (projectRules(d, s.projectKey).length) perms.push(button(t('📌 Правила проекта'), `sm:prm:${s.id}`))
  if (perms.length) rows.push(perms)
  if (s.tmuxPane) rows.push([button('🧹 /compact', `sm:cmp:${s.id}`), button('🆕 /clear', `sm:clr:${s.id}`), button(t('🧠 Модель'), `sm:mdl:${s.id}`)])
  if (s.tmuxPane) rows.push([button(t('🕘 Прошлые разговоры'), `sm:hist:${s.id}`), button(t('⚡ Быстрые команды'), `mc:list:${s.id}`)])
  const link = s.topic ? topicLink(s.topic.chatId, s.topic.threadId) : null
  if (link) rows.push([InlineKeyboard.url(clip(t('💬 Открыть топик «{name}»', { name: s.topic!.name }), 40), link)])

  // The current value is marked; tapping it again does nothing harmful.
  rows.push(([0, 1, 2] as const).map(v => button(`${p.verbose === v ? '• ' : ''}${verboseBadge(v)}`, `sm:v:${s.id}:${v}`, p.verbose === v ? 'primary' : undefined)))
  rows.push((['off', 'long', 'always'] as const).map(v => button(`${p.notifyDone === v ? '• ' : ''}✅ ${v === 'long' ? t('долгие') : t(NOTIFY_DONE_INFO[v])}`, `sm:n:${s.id}:${v}`, p.notifyDone === v ? 'primary' : undefined)))
  rows.push([button(t('« К списку'), 'sm:list'), button('🔄', `sm:s:${s.id}`)])

  const where = c.threadId != null ? t('в топике') : s.group ? t('в группе') : d.userIdOf(s) ? t('в личке пользователя') : t('в личке')
  const text = `${await sessionCard(d, s)}\n\n<i>${t('Подробность прогресса и «✅ готово» {where}:', { where })}</i>`
  return { text, kb: new InlineKeyboard(rows as never) }
}

/** Claude Code models offered in 🧠 Модель: /model takes the id. */
const MODELS: [string, string][] = [['opus', 'claude-opus-5-5'], ['sonnet', 'claude-sonnet-5-5'], ['haiku', 'claude-haiku-5-5'], ['fable', 'claude-fable-5-1']]

/**
 * /compact, /clear (asked first) and /model typed into the session's pane.
 * Only between turns: typed mid-turn they would land in the prompt queue.
 */
async function controlAction(d: Daemon, s: Session, action: string, value: string | undefined): Promise<{ toast?: string; screen?: Screen; sent?: boolean }> {
  if (!s.tmuxPane) return { toast: t('Сессия не в tmux — команды не отправить.') }
  if (action === 'mdl') {
    const rows = MODELS.map(([alias, id]) => [button(`🧠 ${id.replace(/^claude-/, '')}`, `sm:model:${s.id}:${alias}`)])
    rows.push([button(t('« Назад'), `sm:s:${s.id}`)])
    return { screen: { text: t('🧠 Модель для сессии #{id} ({v}). Команда <code>/model</code> уйдёт в её окно tmux.', { id: s.id, v: escapeHtml(projectTitle(s)) }), kb: new InlineKeyboard(rows) } }
  }
  if (action === 'clr') {
    const kb = new InlineKeyboard([[button(t('✅ Да, /clear'), `sm:clrok:${s.id}`, 'danger'), button(t('Отмена'), `sm:s:${s.id}`)]])
    return { screen: { text: t('Очистить разговор сессии #{id} ({v})? Контекст начнётся заново, транскрипт останется для <code>--resume</code>.', { id: s.id, v: escapeHtml(projectTitle(s)) }), kb } }
  }
  if (s.turn || s.status !== 'idle') return { toast: t('Сессия работает — дождитесь конца хода или нажмите ⏹.') }
  const line = action === 'cmp' ? '/compact' : action === 'clrok' ? '/clear' : action === 'resume' ? `/resume ${value}` : `/model ${MODELS.find(([a]) => a === value)?.[1] ?? ''}`
  if (line === '/model ') return { toast: t('Неизвестная модель.') }
  await d.tmuxType(s.tmuxPane, line)
  if (action === 'clrok') s.contextWarned = false
  return { toast: `➡️ ${line}`, sent: true }
}

const dashless = (id: string) => id.replace(/-/g, '')

function when(ms: number): string {
  return new Date(ms).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 🕘 The project's conversations, newest first; the current one is marked. */
async function historyScreen(s: Session): Promise<Screen> {
  const list = await listConversations(s.cwd)
  const lines = [t('🕘 <b>Разговоры</b> · {v}', { v: escapeHtml(projectTitle(s)) }), t('Выбранный продолжится в этой же сессии командой <code>/resume</code> — без перезапуска.'), '']
  const rows: Btn[][] = []
  for (const c of list) {
    const current = c.id === s.claude.sessionId
    const prompt = c.prompt ? clip(c.prompt, 70) : t('(без текста)')
    lines.push(`${current ? '▶️' : '•'} ${when(c.mtime)} · ${t('{n} КБ', { n: Math.max(1, Math.round(c.size / 1024)) })}${current ? t(' · <b>сейчас</b>') : ''}\n   ${escapeHtml(prompt)}`)
    if (!current) rows.push([button(clip(`${when(c.mtime)} ${c.prompt || '…'}`, 40), `sm:rs:${s.id}:${dashless(c.id)}`)])
  }
  if (!list.length) lines.push(t('Транскриптов этой папки нет.'))
  rows.push([button(t('« Назад'), `sm:s:${s.id}`)])
  return { text: lines.join('\n'), kb: new InlineKeyboard(rows as never) }
}

/** 📌 Tools allowed for the project for good, each with a button to ask again. */
function rulesScreen(d: Daemon, s: Session): Screen {
  const rules = projectRules(d, s.projectKey)
  const lines = [t('📌 <b>Без вопросов в проекте</b> {v}', { v: escapeHtml(projectTitle(s)) }), rules.length ? t('Эти инструменты разрешаются сами в любой сессии проекта, и после перезапуска тоже. ❌ — снова спрашивать.') : t('Правил нет.')]
  const rows: Btn[][] = rules.slice(0, 20).map((t, i) => [button(clip(`❌ ${t}`, 40), `sm:prmd:${s.id}:${i}`)])
  rows.push([button(t('« Назад'), `sm:s:${s.id}`)])
  return { text: lines.join('\n'), kb: new InlineKeyboard(rows as never) }
}

async function gitScreen(s: Session): Promise<Screen> {
  const back = [button(t('« Назад'), `sm:s:${s.id}`), button('🔄', `sm:git:${s.id}`)]
  const g = await gitInfo(s.cwd)
  if (!g) return { text: t('🌿 <code>{v}</code> — не git-репозиторий.', { v: escapeHtml(s.cwd) }), kb: new InlineKeyboard([back]) }
  const parts = [`🌿 <b>Git</b> · ${escapeHtml(projectTitle(s))}`, `<pre>${escapeHtml(g.status)}</pre>`]
  if (g.log) parts.push(t('Последние коммиты:\n<pre>{v}</pre>', { v: escapeHtml(g.log) }))
  if (g.pr) parts.push(`🔀 PR <a href="${escapeHtml(g.pr.url)}">#${g.pr.number}</a> · ${escapeHtml(g.pr.state.toLowerCase())} · ${escapeHtml(g.pr.title)}`)
  let text = parts.join('\n')
  if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE - 1) + '…'
  const rows: Btn[][] = [[button(t('📄 diff файлом'), `sm:gdf:${s.id}`)]]
  if (g.pr) rows[0].push(InlineKeyboard.url(`🔀 PR #${g.pr.number}`, g.pr.url))
  rows.push(back)
  return { text, kb: new InlineKeyboard(rows as never) }
}

export async function show(ctx: Context, sc: Screen): Promise<void> {
  await ctx.editMessageText(sc.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: sc.kb })
    .catch(err => { if (!isMessageNotModified(err)) throw err })
}

/** sm:list, sm:s:<id>, sm:stop|main|ar|arok|cmp|cmpn|clr|clrok|mdl|hist|prm:<id>, sm:rs|rsok:<id>:<conversation id without dashes>, sm:prmd:<id>:<n>, sm:model:<id>:<alias>, sm:v:<id>:<0-2>, sm:n:<id>:<off|long|always> */
export async function handleSessionMenu(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^sm:([a-z]+)(?::([0-9a-f]+))?(?::(\w+))?$/.exec(data)
  if (!m) return false
  const [, action, id, value] = m
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || !can(ctx.from.id, 'control')) {
    await answer(t('Нет доступа.'))
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
    await answer(t('Сессия уже отключена.'))
    await show(ctx, await sessionsList(d))
    return true
  }
  let toast: string | undefined
  if (action === 'git') {
    await answer()
    await show(ctx, await gitScreen(s))
    return true
  }
  if (action === 'hist') {
    await answer()
    await show(ctx, await historyScreen(s))
    return true
  }
  if (action === 'prm' || action === 'prmd') {
    const rules = projectRules(d, s.projectKey)
    const tool = action === 'prmd' ? rules[Number(value)] : undefined
    if (tool) removeProjectRule(d, s.projectKey, tool)
    await answer(tool ? t('🔐 {tool} снова спрашивается', { tool }) : undefined)
    await show(ctx, rulesScreen(d, s))
    return true
  }
  if (action === 'rs' || action === 'rsok') {
    const c = (await listConversations(s.cwd, 200)).find(x => dashless(x.id) === value)
    if (!c) { await answer(t('Разговор не найден.')); return true }
    if (action === 'rs') {
      await answer()
      const kb = new InlineKeyboard([[button(t('🕘 Да, продолжить его'), `sm:rsok:${s.id}:${value}`, 'primary'), button(t('Отмена'), `sm:hist:${s.id}`)]])
      await show(ctx, { text: t('Продолжить разговор от {v} в сессии #{id}?\n\n<i>{v2}</i>\n\nТекущий разговор сохранится — вернуться к нему можно так же.', { v: when(c.mtime), id: s.id, v2: escapeHtml(clip(c.prompt || t('(без текста)'), 300)) }), kb })
      return true
    }
    const r = await controlAction(d, s, 'resume', c.id)
    await answer(r.toast)
    if (r.sent) await show(ctx, await sessionScreen(d, s))
    return true
  }
  if (action === 'gdf') {
    const diff = await gitDiff(s.cwd)
    if (diff == null) { await answer(t('Не удалось получить diff.')); return true }
    if (!diff.trim()) { await answer(t('Изменений нет: рабочее дерево чистое.')); return true }
    await answer(t('📄 Отправляю diff'))
    const name = `${s.projectName}${s.branch ? `-${s.branch.replace(/[^\w.-]+/g, '_')}` : ''}.diff`
    const thread = ctx.callbackQuery?.message?.message_thread_id
    await ctx.replyWithDocument(new InputFile(Buffer.from(diff), name), {
      caption: `📄 git diff HEAD · ${projectTitle(s)} · ${t('{n} файл(ов)', { n: diff.split('\n').filter(l => /^diff --git/.test(l)).length })}`,
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
    toast = t('🔐 Разрешения снова спрашиваются')
  } else if (action === 'stop') {
    toast = stopSession(d, s) === 'interrupted' ? t('⏹ Остановлено') : t('Сейчас нечего останавливать.')
  } else if (action === 'main') {
    d.store.set('main_dir', s.projectKey)
    toast = t('👑 Главная → #{id}', { id: s.id })
  } else if (action === 'ar' && s.topic) {
    await answer()
    const kb = new InlineKeyboard([[button(t('✅ Да, в архив'), `sm:arok:${s.id}`, 'danger'), button(t('Отмена'), `sm:s:${s.id}`)]])
    await show(ctx, { text: t('Архивировать «{v}»? Сессия #{id} будет закрыта, топик — закрыт.', { v: escapeHtml(s.topic.name), id: s.id }), kb })
    return true
  } else if (action === 'arok' && s.topic) {
    const stuck = await archiveTopic(d, s.topic.chatId, s.topic.threadId)
    await answer()
    const text = stuck.length ? t('🗄 Топик в архиве. Сессию #{id} закрыть не смог (не в tmux) — закройте её сами.', { id: s.id }) : t('🗄 В архиве, сессия #{id} закрывается.', { id: s.id })
    await show(ctx, { text, kb: new InlineKeyboard([[button(t('« К списку'), 'sm:list')]]) })
    return true
  } else if (action === 'v' && ['0', '1', '2'].includes(value ?? '')) {
    const c = sessionChat(d, s)
    const v = Number(value) as 0 | 1 | 2
    setPref(c.threadId != null ? `${c.chatId}:${c.threadId}` : c.chatId, { verbose: v })
    toast = t('Подробность: {v}', { v: verboseBadge(v) })
  } else if (action === 'n' && (value === 'off' || value === 'long' || value === 'always')) {
    const c = sessionChat(d, s)
    setPref(c.threadId != null ? `${c.chatId}:${c.threadId}` : c.chatId, { notifyDone: value })
    toast = t('✅ готово: {v}', { v: t(NOTIFY_DONE_INFO[value]) })
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
  const text = t('🧠 Контекст сессии {v} (#{id}) заполнен на <b>{v2}%</b>. Сжать разговор?', { v: escapeHtml(sessionLabel(d, s)), id: s.id, v2: Math.round(fill) })
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
  const lines = [t('🔐 <b>Ждут разрешения</b> ({length})', { length: items.length })]
  for (const [rid, p] of items.slice(0, 15)) {
    const s = d.sessions.get(p.sessionId)
    const who = s ? sessionLabel(d, s) : `#${p.sessionId}`
    const desc = p.description.length > 80 ? p.description.slice(0, 79) + '…' : p.description
    lines.push(`• ${escapeHtml(who)} · <b>${escapeHtml(p.tool_name)}</b>${desc ? ` — ${escapeHtml(desc)}` : ''}`)
    rows.push([button(clip(`✅ ${p.tool_name} · ${who}`, 40), `perm:allow:${rid}`, 'success'), button('❌', `perm:deny:${rid}`, 'danger')])
  }
  if (!items.length) lines.push(t('Ничего не ждёт.'))
  rows.push([button(t('« К сессиям'), 'sm:list'), button('🔄', 'sm:perms'), button(t('« Меню'), 'hub:main')])
  return { text: lines.join('\n'), kb: new InlineKeyboard(rows as never) }
}
