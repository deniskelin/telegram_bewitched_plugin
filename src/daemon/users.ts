/**
 * 🚫 Removing a user, from the bot: their access, their Claude Code session
 * and tmux window, their folder and transcripts, and what the bot kept about
 * their DMs (history, queue, memory, reminders, prefs). Owner only, after a
 * confirmation that lists exactly what goes. /users lists everyone allowed.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join, resolve, sep } from 'path'
import { loadAccess, owner, roleOf, saveAccess, setRole } from '../access.ts'
import { MEMORY_DIR, settings } from '../config.ts'
import { clip, escapeHtml } from '../format.ts'
import { userPendingKey, type Daemon } from './daemon.ts'
import { show } from './menu.ts'
import { listReminders } from './reminders.ts'
import { button } from './stream.ts'
import { projectTranscriptDir } from './transcript.ts'
import { isAlive } from '../proc.ts'
import { t } from '../i18n/index.ts'

function isPrimaryOwner(ctx: Context): boolean {
  return !!ctx.from && String(ctx.from.id) === owner()
}

/** USERS_DIR/<id>, only for a numeric id and only inside USERS_DIR. */
function userDir(id: string): string | null {
  if (!/^\d+$/.test(id)) return null
  const dir = resolve(settings.usersDir, id)
  return dir.startsWith(resolve(settings.usersDir) + sep) ? dir : null
}

function dirSize(path: string): number {
  let total = 0
  try {
    for (const name of readdirSync(path)) {
      const p = join(path, name)
      const st = statSync(p)
      total += st.isDirectory() ? dirSize(p) : st.size
    }
  } catch {}
  return total
}

function fmtSize(n: number): string {
  return n >= 1e6 ? t('{v} МБ', { v: (n / 1e6).toFixed(1) }) : n >= 1e3 ? t('{v} КБ', { v: Math.round(n / 1e3) }) : t('{n} Б', { n })
}

function label(d: Daemon, id: string): string {
  return d.userLabel(id)
}

const REMOVE_RECHECK_MS = 1000

/** Wait up to ms for a process to exit; true when it is gone (or unknown). */
async function waitExit(pid: number | null, ms = 10_000): Promise<boolean> {
  if (!pid) return true
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(200)) if (!isAlive(pid)) return true
  return !isAlive(pid)
}

/** What removal will touch, for the confirmation. */
function plan(d: Daemon, id: string): string[] {
  const out: string[] = [t('• доступ: id из <code>allowFrom</code>')]
  const s = d.userSession(id)
  if (s) out.push(t('• сессия #{id}{v}', { id: s.id, v: s.tmuxPane ? t(' и её окно tmux (<code>{v}</code>)', { v: escapeHtml(s.tmuxPane) }) : t(' (не в tmux — закройте её сами)') }))
  const dir = userDir(id)
  if (dir && existsSync(dir)) out.push(t('• папка <code>{v}</code> ({v2})', { v: escapeHtml(dir), v2: fmtSize(dirSize(dir)) }))
  const tr = dir ? projectTranscriptDir(dir) : null
  if (tr && existsSync(tr)) out.push(t('• транскрипты Claude Code <code>{v}</code> ({v2})', { v: escapeHtml(tr), v2: fmtSize(dirSize(tr)) }))
  out.push(t('• история лички с ботом, очередь, память чата, напоминания и настройки'))
  return out
}

export function confirmScreen(d: Daemon, id: string, back: string): { text: string; kb: InlineKeyboard } {
  const kb: ReturnType<typeof button>[][] = [[button(t('🚫 Удалить всё'), `ur:ok:${id}`, 'danger')]]
  if (d.topicsChatId) kb.push([button(t('🚫 Удалить и исключить из группы'), `ur:kick:${id}`, 'danger')])
  kb.push([button(t('Отмена'), back)])
  return {
    text: [t('🚫 Удалить <b>{v}</b>?', { v: escapeHtml(label(d, id)) }), '', t('Будет удалено без возможности восстановить:'), ...plan(d, id),
      '', t('Его сообщения в группе остаются. Написать боту снова он сможет только после нового приглашения.')].join('\n'),
    kb: new InlineKeyboard(kb),
  }
}

/** Does the removal; returns a report line per step. */
export async function removeUser(d: Daemon, id: string, o: { kick?: boolean } = {}): Promise<string[]> {
  const done: string[] = []
  const a = loadAccess()
  a.allowFrom = a.allowFrom.filter(x => x !== id)
  for (const g of Object.values(a.groups)) g.allowFrom = g.allowFrom.filter(x => x !== id)
  if (a.prefs?.chats) delete a.prefs.chats[id]
  saveAccess(a)
  const known = JSON.parse(d.store.get('known_users') ?? '[]') as string[]
  d.store.set('known_users', JSON.stringify(known.filter(x => x !== id)))
  done.push(t('✅ доступ снят'))

  const s = d.userSession(id)
  if (s?.tmuxPane) {
    d.ending.add(s.id) // planned: no "session stopped" notice
    await d.tmuxKillWindow(s.tmuxPane).then(() => done.push(t('✅ сессия #{id} и окно tmux закрыты', { id: s.id })), err => done.push(t('⚠️ окно tmux: {v}', { v: escapeHtml(String(err)) })))
    // Claude Code writes its last transcript lines while exiting: deleting before that recreates the folder.
    if (!(await waitExit(s.claudePid))) done.push(t('⚠️ процесс Claude Code ({pid}) ещё не завершился — транскрипты могут появиться снова', { pid: s.claudePid ?? '?' }))
  } else if (s) done.push(t('⚠️ сессия #{id} не в tmux — закройте её сами', { id: s.id }))

  const dir = userDir(id)
  if (dir) {
    d.launching.delete(dir)
    const tr = projectTranscriptDir(dir)
    for (const [what, path] of [[t('папка'), dir], [t('транскрипты'), tr]] as const) {
      if (!existsSync(path)) continue
      try {
        rmSync(path, { recursive: true, force: true })
        done.push(t('✅ {what} удалена: <code>{v}</code>', { what, v: escapeHtml(path) }))
      } catch (err) {
        done.push(`⚠️ ${what}: ${escapeHtml(String(err))}`)
      }
    }
    // A last write that raced the exit: check once more.
    await Bun.sleep(REMOVE_RECHECK_MS)
    if (existsSync(tr)) rmSync(tr, { recursive: true, force: true })
  }

  const msgs = d.store.forgetThread(id, null)
  const queued = d.store.dropPending(userPendingKey(id))
  rmSync(join(MEMORY_DIR, `${id}_0.md`), { force: true })
  const reminders = listReminders(d)
  d.store.set('reminders', JSON.stringify(reminders.filter(r => r.chatId !== id)))
  d.store.set(`user_name:${id}`, null)
  d.store.set(`user_info:${id}`, null)
  done.push(t('✅ история лички: {msgs} сообщ., очередь: {queued}, напоминаний: {v}', { msgs, queued, v: reminders.length - listReminders(d).length }))

  if (o.kick && d.topicsChatId) {
    // Ban then unban: removed from the group, free to be invited again later.
    await d.bot.api.banChatMember(d.topicsChatId, Number(id))
      .then(() => d.bot.api.unbanChatMember(d.topicsChatId!, Number(id), { only_if_banned: true }))
      .then(() => done.push(t('✅ исключён из группы')), err => done.push(t('⚠️ из группы исключить не вышло: {v}', { v: escapeHtml(String(err)) })))
  }
  d.log(`removed user ${id}`)
  d.onSessionsChanged()
  return done
}

export function usersScreen(d: Daemon): { text: string; kb: InlineKeyboard } {
  const [first, ...rest] = loadAccess().allowFrom
  const lines = [t('👥 <b>Пользователи</b>'), t('👑 {v} — владелец', { v: escapeHtml(label(d, first ?? '?')) })]
  const kb: ReturnType<typeof button>[][] = []
  for (const id of rest) {
    const s = d.userSession(id)
    const viewer = roleOf(id) === 'viewer'
    lines.push(`${viewer ? '👁' : '👤'} ${escapeHtml(label(d, id))} · ${viewer ? t('наблюдатель') : t('участник')} · ${s ? t('сессия #{id}', { id: s.id }) : t('сессия не запущена')}`)
    kb.push([
      button(clip(`${viewer ? '👤' : '👁'} ${label(d, id)}`, 32), `ur:role:${id}:${viewer ? 'm' : 'v'}`),
      button(clip(`🚫 ${label(d, id)}`, 32), `ur:ask:${id}`),
    ])
  }
  if (!rest.length) lines.push('', t('Кроме вас — никого.'))
  else lines.push('', t('👤 участник — пишет в сессии, отвечает на кнопки, жмёт ⏹; разрешения, архив, люди и настройки — только у владельца. 👁 наблюдатель только читает. Кнопка слева меняет роль.'))
  kb.push([button(t('👥 Пригласить'), 'inv:start'), button(t('« Меню'), 'hub:main')])
  return { text: lines.join('\n'), kb: new InlineKeyboard(kb) }
}

export function registerUserCommands(d: Daemon, bot: Bot): void {
  bot.command('users', async ctx => {
    if (ctx.chat?.type !== 'private' || !isPrimaryOwner(ctx)) return
    const { text, kb } = usersScreen(d)
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb })
  })
}

/** ur:ask|ok|kick:<id>, ur:list */
export async function handleUserCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^ur:(ask|ok|kick|list|role)(?::(\d+))?(?::([mv]))?$/.exec(data)
  if (!m) return false
  if (!isPrimaryOwner(ctx)) {
    await ctx.answerCallbackQuery({ text: t('Удалять пользователей может только владелец.') }).catch(() => {})
    return true
  }
  const [, action, id] = m
  if (action === 'role' && id && id !== owner()) {
    setRole(id, m[3] === 'v' ? 'viewer' : 'member')
    await ctx.answerCallbackQuery({ text: m[3] === 'v' ? t('👁 Теперь наблюдатель') : t('👤 Теперь участник') }).catch(() => {})
    await show(ctx, usersScreen(d))
    return true
  }
  if (action === 'list') {
    await ctx.answerCallbackQuery().catch(() => {})
    await show(ctx, usersScreen(d))
    return true
  }
  if (!id || id === owner()) {
    await ctx.answerCallbackQuery({ text: t('Владельца удалить нельзя.') }).catch(() => {})
    return true
  }
  if (action === 'ask') {
    await ctx.answerCallbackQuery().catch(() => {})
    const s = d.userSession(id)
    await show(ctx, confirmScreen(d, id, s ? `sm:s:${s.id}` : 'ur:list'))
    return true
  }
  if (!loadAccess().allowFrom.includes(id)) {
    await ctx.answerCallbackQuery({ text: t('Уже удалён.') }).catch(() => {})
    return true
  }
  await ctx.answerCallbackQuery({ text: t('🚫 Удаляю…') }).catch(() => {})
  const who = label(d, id)
  const done = await removeUser(d, id, { kick: action === 'kick' })
  await show(ctx, { text: [t('🚫 <b>{v}</b> удалён.', { v: escapeHtml(who) }), '', ...done].join('\n'), kb: new InlineKeyboard([[button(t('« Пользователи'), 'ur:list')]]) })
  return true
}
