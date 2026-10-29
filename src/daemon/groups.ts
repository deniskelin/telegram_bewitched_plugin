/**
 * Ordinary groups (not the topics group) as projects. A group allowed in
 * access.json gets bound, by the owner in DM, to a project folder: then its
 * messages go to that project's session, started on demand like a topic's,
 * and the session answers in the group. Or it is marked "not a project" and
 * goes to the main session as before. Until the owner decides, its messages
 * wait in a queue.
 *
 * Everything is controlled from the owner's DM: the binding card, the
 * session card in /sessions, the list in /menu → 👥 Группы. Permission
 * requests of a group's session go to the owner only.
 *
 * Callback data: gp:new|none|pick|ask|unbind|unbok:<chat>[:<n>], gp:list
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { isOwner, loadAccess, owner } from '../access.ts'
import { settings } from '../config.ts'
import { clip, escapeHtml } from '../format.ts'
import { t } from '../i18n/index.ts'
import { MAIN_PENDING_KEY, type Daemon } from './daemon.ts'
import { inChat } from './lang.ts'
import { endSession, launchOnce, manualCmd, screenKb, sessionName, slugify } from './launch.ts'
import { show, type Screen } from './menu.ts'
import { button } from './stream.ts'

/** dir null: "not a project" — the main session answers, as before. */
export type GroupBinding = { dir: string | null; title: string }

const KEY = 'group_bindings'

export function groupBindings(d: Daemon): Record<string, GroupBinding> {
  try {
    return JSON.parse(d.store.get(KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function groupBinding(d: Daemon, chatId: string): GroupBinding | null {
  return groupBindings(d)[chatId] ?? null
}

function save(d: Daemon, all: Record<string, GroupBinding>): void {
  d.store.set(KEY, Object.keys(all).length ? JSON.stringify(all) : null)
}

export function setGroupBinding(d: Daemon, chatId: string, b: GroupBinding | null): void {
  const all = groupBindings(d)
  if (b) all[chatId] = b
  else delete all[chatId]
  save(d, all)
}

/** The group a project folder is bound to. */
export function groupForProject(d: Daemon, dir: string): { chatId: string; title: string } | null {
  for (const [chatId, b] of Object.entries(groupBindings(d))) if (b.dir === dir) return { chatId, title: b.title }
  return null
}

/** A group's messages while the owner hasn't decided what it is. */
export const groupPendingKey = (chatId: string) => `group:${chatId}`

/** Is this a group that can be a project: allowed in access.json, not the topics group. */
export function isProjectGroup(d: Daemon, chatId: string): boolean {
  return chatId.startsWith('-') && chatId !== d.topicsChatId && !!loadAccess().groups[chatId]
}

/** Folders in PROJECTS_DIR, newest first — for «📂 Выбрать проект». */
function projectDirs(): string[] {
  try {
    return readdirSync(settings.projectsDir)
      .filter(n => !n.startsWith('.'))
      .map(n => join(settings.projectsDir, n))
      .filter(p => statSync(p).isDirectory())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, 10)
  } catch {
    return []
  }
}

function newDir(title: string): string {
  return join(settings.projectsDir, slugify(title) || 'group')
}

/** The owner's card: what is this group? */
function bindScreen(d: Daemon, chatId: string, title: string): Screen {
  const lines = [
    t('👥 Группа <b>{title}</b> (<code>{chat}</code>) пишет боту, но ещё не привязана.', { title: escapeHtml(title), chat: chatId }),
    t('Сделать её проектом? Сессия проекта будет отвечать прямо в группу, управление — отсюда.'),
  ]
  return {
    text: lines.join('\n'),
    kb: new InlineKeyboard([
      [button(clip(t('📁 Новый: {dir}', { dir: newDir(title).replace(process.env.HOME ?? '\0', '~') }), 40), `gp:new:${chatId}`, 'success')],
      [button(t('📂 Выбрать проект'), `gp:ask:${chatId}`)],
      [button(t('🚫 Не проект (главная сессия)'), `gp:none:${chatId}`)],
    ]),
  }
}

function pickScreen(chatId: string): Screen {
  const dirs = projectDirs()
  const rows = dirs.map((p, i) => [button(clip(`📂 ${p.replace(process.env.HOME ?? '\0', '~')}`, 40), `gp:pick:${chatId}:${i}`)])
  rows.push([button(t('« Назад'), `gp:back:${chatId}`)])
  return { text: dirs.length ? t('Какой проект привязать к группе?') : t('В {dir} пока нет папок проектов.', { dir: settings.projectsDir }), kb: new InlineKeyboard(rows) }
}

/** Ask the owner once (until answered) what an unbound group is. */
export async function askOwnerAboutGroup(d: Daemon, chatId: string, title?: string): Promise<boolean> {
  const o = owner()
  if (!o || d.store.get(`group_asked:${chatId}`)) return false
  d.store.set(`group_asked:${chatId}`, String(Date.now()))
  const name = title ?? (await d.bot.api.getChat(chatId).then(c => ('title' in c ? c.title : undefined) ?? chatId, () => chatId))
  const sc = inChat(d, o, undefined, () => bindScreen(d, chatId, name))
  await d.bot.api.sendMessage(o, sc.text, { parse_mode: 'HTML', reply_markup: sc.kb }).catch(err => d.log(`group card failed: ${err}`))
  return true
}

/** Start the session of a group's project; the group hears it is starting, the owner confirms. */
export async function launchForGroup(d: Daemon, chatId: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const r = await launchOnce(d, dir, { name: sessionName(d, dir) })
  const o = owner()
  const say = (to: string, text: string, kb?: InlineKeyboard) =>
    d.bot.api.sendMessage(to, text, { parse_mode: 'HTML', ...(kb ? { reply_markup: kb } : {}) }).catch(err => d.log(`group launch notice failed: ${err}`))
  if (!r.ok && r.skipped) return
  if (r.ok) {
    await inChat(d, chatId, undefined, () => say(chatId, t('🚀 Запускаю сессию проекта — сообщение дойдёт, когда она подключится.')))
    if (o) await inChat(d, o, undefined, () => say(o, t('🚀 Группа «{title}»: запускаю сессию проекта <code>{dir}</code> в tmux (окно {win}). Подтвердите запуск:', { title: escapeHtml(groupBinding(d, chatId)?.title ?? chatId), dir: escapeHtml(dir), win: escapeHtml(r.window) }), screenKb(r.window)))
    return
  }
  await inChat(d, chatId, undefined, () => say(chatId, t('❌ Не удалось запустить сессию проекта. Сообщение сохранено.')))
  if (o) await inChat(d, o, undefined, () => say(o, t('❌ Группа «{title}»: не удалось запустить сессию: {err}', { title: escapeHtml(groupBinding(d, chatId)?.title ?? chatId), err: escapeHtml(r.error) }) + manualCmd(dir, { name: sessionName(d, dir) })))
}

/** Bind and hand over what waited: to the project (launching its session) or to the main session. */
async function bind(d: Daemon, chatId: string, dir: string | null, title: string): Promise<void> {
  setGroupBinding(d, chatId, { dir, title })
  d.store.set(`group_asked:${chatId}`, null)
  const waiting = d.store.takePending(groupPendingKey(chatId), settings.pendingTtlH)
  if (dir) {
    mkdirSync(dir, { recursive: true })
    for (const p of waiting) d.store.addPending(dir, p.content, p.meta)
    const s = d.sessionForProject(dir)
    if (s) {
      s.group = { chatId, title }
      s.topic = null
      for (const p of d.store.takePending(dir, settings.pendingTtlH)) d.deliver(s, p.content, p.meta, { chatId, isPrivate: false })
    } else await launchForGroup(d, chatId, dir)
    return
  }
  const main = d.mainSession()
  for (const p of waiting) {
    if (main) d.deliver(main, p.content, p.meta, { chatId, isPrivate: false })
    else d.store.addPending(MAIN_PENDING_KEY, p.content, p.meta)
  }
}

export function groupsScreen(d: Daemon): Screen {
  const all = Object.entries(groupBindings(d))
  const lines = [t('👥 <b>Группы</b>'), all.length ? t('Обычные группы без топиков: проект или главная сессия.') : t('Ни одна группа ещё не привязана. Добавьте бота в группу и разрешите её: <code>/telegram-bewitched:access group add &lt;id&gt;</code>.')]
  const rows = []
  for (const [chatId, b] of all) {
    const s = b.dir ? d.sessionForProject(b.dir) : null
    lines.push(b.dir
      ? t('• <b>{title}</b> → <code>{dir}</code>{state}', { title: escapeHtml(b.title), dir: escapeHtml(b.dir), state: s ? t(' · сессия #{id}', { id: s.id }) : t(' · сессия не запущена') })
      : t('• <b>{title}</b> → главная сессия', { title: escapeHtml(b.title) }))
    rows.push(b.dir
      ? [button(clip(`🚫 ${b.title}`, 40), `gp:unbind:${chatId}`)]
      : [button(clip(t('📁 Сделать проектом: {title}', { title: b.title }), 40), `gp:redo:${chatId}`)])
  }
  rows.push([button(t('« Меню'), 'hub:main')])
  return { text: lines.join('\n'), kb: new InlineKeyboard(rows) }
}

export function registerGroupHandlers(d: Daemon, bot: Bot): void {
  // The bot added to a group: an allowed one is offered as a project; another gets a hint, never access.
  bot.on('my_chat_member', async (ctx, next) => {
    const upd = ctx.myChatMember
    const chatId = String(upd.chat.id)
    const added = ['member', 'administrator'].includes(upd.new_chat_member.status) && ['left', 'kicked'].includes(upd.old_chat_member.status)
    const o = owner()
    if (added && o && chatId.startsWith('-') && chatId !== d.topicsChatId && !groupBinding(d, chatId)) {
      const title = ('title' in upd.chat ? upd.chat.title : undefined) ?? chatId
      if (isProjectGroup(d, chatId)) await askOwnerAboutGroup(d, chatId, title)
      else await inChat(d, o, undefined, () => d.bot.api.sendMessage(o, t('👥 Бота добавили в группу «{title}» (<code>{chat}</code>). Она не разрешена — бот там молчит. Разрешить можно в терминале:', { title: escapeHtml(title), chat: chatId }) + `\n<code>/telegram-bewitched:access group add ${chatId}</code>`, { parse_mode: 'HTML' })).catch(() => {})
    }
    return next()
  })
}

export async function handleGroupCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^gp:(?:(list)|(new|none|ask|back|pick|unbind|unbok|redo):(-\d+)(?::(\d+))?)$/.exec(data)
  if (!m) return false
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || String(ctx.from.id) !== owner()) {
    await answer(t('Только для владельца.'))
    return true
  }
  if (m[1]) {
    await answer()
    await show(ctx, groupsScreen(d))
    return true
  }
  const [, , action, chatId, n] = m
  const title = groupBinding(d, chatId)?.title ?? (await d.bot.api.getChat(chatId).then(c => ('title' in c ? c.title : undefined) ?? chatId, () => chatId))
  const done = (text: string) => show(ctx, { text, kb: new InlineKeyboard([[button(t('👥 Группы'), 'gp:list')]]) })
  switch (action) {
    case 'ask':
      await answer()
      await show(ctx, pickScreen(chatId))
      return true
    case 'back':
    case 'redo':
      await answer()
      await show(ctx, bindScreen(d, chatId, title))
      return true
    case 'new':
    case 'pick': {
      const dir = action === 'new' ? newDir(title) : projectDirs()[Number(n)]
      if (!dir) { await answer(t('Папка не найдена.')); return true }
      const other = groupForProject(d, dir)
      if (other && other.chatId !== chatId) { await answer(t('Этот проект уже привязан к группе «{title}».', { title: other.title })); return true }
      await answer(t('📁 Привязываю…'))
      await bind(d, chatId, dir, title)
      await done(t('✅ Группа <b>{title}</b> — проект <code>{dir}</code>. Её сессия отвечает в группу; карточка — в /sessions.', { title: escapeHtml(title), dir: escapeHtml(dir) }))
      return true
    }
    case 'none':
      await answer()
      await bind(d, chatId, null, title)
      await done(t('✅ Группа <b>{title}</b> не проект: ей отвечает главная сессия.', { title: escapeHtml(title) }))
      return true
    case 'unbind':
      await answer()
      await show(ctx, {
        text: t('Отвязать группу <b>{title}</b> от проекта? Её сессия закроется, папка останется. Следующее сообщение из группы снова спросит, что это.', { title: escapeHtml(title) }),
        kb: new InlineKeyboard([[button(t('🚫 Да, отвязать'), `gp:unbok:${chatId}`, 'danger'), button(t('Отмена'), 'gp:list')]]),
      })
      return true
    case 'unbok': {
      const b = groupBinding(d, chatId)
      setGroupBinding(d, chatId, null)
      const s = b?.dir ? d.sessionForProject(b.dir) : null
      if (s) {
        s.group = null
        endSession(d, s)
      }
      await answer(t('🚫 Отвязано'))
      await show(ctx, groupsScreen(d))
      return true
    }
  }
  return true
}
