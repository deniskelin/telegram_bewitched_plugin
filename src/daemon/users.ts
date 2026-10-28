/**
 * 🚫 Removing a user, from the bot: their access, their Claude Code session
 * and tmux window, their folder and transcripts, and what the bot kept about
 * their DMs (history, queue, memory, reminders, prefs). Owner only, after a
 * confirmation that lists exactly what goes. /users lists everyone allowed.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join, resolve, sep } from 'path'
import { loadAccess, owner, saveAccess } from '../access.ts'
import { MEMORY_DIR, settings } from '../config.ts'
import { clip, escapeHtml } from '../format.ts'
import { userPendingKey, type Daemon } from './daemon.ts'
import { show } from './menu.ts'
import { listReminders } from './reminders.ts'
import { button } from './stream.ts'
import { projectTranscriptDir } from './transcript.ts'

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
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} МБ` : n >= 1e3 ? `${Math.round(n / 1e3)} КБ` : `${n} Б`
}

function label(d: Daemon, id: string): string {
  return d.userLabel(id)
}

/** What removal will touch, for the confirmation. */
function plan(d: Daemon, id: string): string[] {
  const out: string[] = ['• доступ: id из <code>allowFrom</code>']
  const s = d.userSession(id)
  if (s) out.push(`• сессия #${s.id}${s.tmuxPane ? ` и её окно tmux (<code>${escapeHtml(s.tmuxPane)}</code>)` : ' (не в tmux — закройте её сами)'}`)
  const dir = userDir(id)
  if (dir && existsSync(dir)) out.push(`• папка <code>${escapeHtml(dir)}</code> (${fmtSize(dirSize(dir))})`)
  const tr = dir ? projectTranscriptDir(dir) : null
  if (tr && existsSync(tr)) out.push(`• транскрипты Claude Code <code>${escapeHtml(tr)}</code> (${fmtSize(dirSize(tr))})`)
  out.push('• история лички с ботом, очередь, память чата, напоминания и настройки')
  return out
}

export function confirmScreen(d: Daemon, id: string, back: string): { text: string; kb: InlineKeyboard } {
  const kb: ReturnType<typeof button>[][] = [[button('🚫 Удалить всё', `ur:ok:${id}`, 'danger')]]
  if (d.topicsChatId) kb.push([button('🚫 Удалить и исключить из группы', `ur:kick:${id}`, 'danger')])
  kb.push([button('Отмена', back)])
  return {
    text: [`🚫 Удалить <b>${escapeHtml(label(d, id))}</b>?`, '', 'Будет удалено без возможности восстановить:', ...plan(d, id),
      '', 'Его сообщения в группе остаются. Написать боту снова он сможет только после нового приглашения.'].join('\n'),
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
  done.push('✅ доступ снят')

  const s = d.userSession(id)
  if (s?.tmuxPane) {
    d.ending.add(s.id) // planned: no "session stopped" notice
    await d.tmuxKillWindow(s.tmuxPane).then(() => done.push(`✅ сессия #${s.id} и окно tmux закрыты`), err => done.push(`⚠️ окно tmux: ${escapeHtml(String(err))}`))
  } else if (s) done.push(`⚠️ сессия #${s.id} не в tmux — закройте её сами`)

  const dir = userDir(id)
  if (dir) {
    d.launching.delete(dir)
    const tr = projectTranscriptDir(dir)
    for (const [what, path] of [['папка', dir], ['транскрипты', tr]] as const) {
      if (!existsSync(path)) continue
      try {
        rmSync(path, { recursive: true, force: true })
        done.push(`✅ ${what} удалена: <code>${escapeHtml(path)}</code>`)
      } catch (err) {
        done.push(`⚠️ ${what}: ${escapeHtml(String(err))}`)
      }
    }
  }

  const msgs = d.store.forgetThread(id, null)
  const queued = d.store.dropPending(userPendingKey(id))
  rmSync(join(MEMORY_DIR, `${id}_0.md`), { force: true })
  const reminders = listReminders(d)
  d.store.set('reminders', JSON.stringify(reminders.filter(r => r.chatId !== id)))
  d.store.set(`user_name:${id}`, null)
  d.store.set(`user_info:${id}`, null)
  done.push(`✅ история лички: ${msgs} сообщ., очередь: ${queued}, напоминаний: ${reminders.length - listReminders(d).length}`)

  if (o.kick && d.topicsChatId) {
    // Ban then unban: removed from the group, free to be invited again later.
    await d.bot.api.banChatMember(d.topicsChatId, Number(id))
      .then(() => d.bot.api.unbanChatMember(d.topicsChatId!, Number(id), { only_if_banned: true }))
      .then(() => done.push('✅ исключён из группы'), err => done.push(`⚠️ из группы исключить не вышло: ${escapeHtml(String(err))}`))
  }
  d.log(`removed user ${id}`)
  d.onSessionsChanged()
  return done
}

function usersScreen(d: Daemon): { text: string; kb: InlineKeyboard } {
  const [first, ...rest] = loadAccess().allowFrom
  const lines = ['👥 <b>Пользователи</b>', `👑 ${escapeHtml(label(d, first ?? '?'))} — владелец`]
  const kb: ReturnType<typeof button>[][] = []
  for (const id of rest) {
    const s = d.userSession(id)
    lines.push(`👤 ${escapeHtml(label(d, id))} · ${s ? `сессия #${s.id}` : 'сессия не запущена'}`)
    kb.push([button(clip(`🚫 ${label(d, id)}`, 40), `ur:ask:${id}`)])
  }
  if (!rest.length) lines.push('', 'Кроме вас — никого.')
  kb.push([button('👥 Пригласить', 'inv:start')])
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
  const m = /^ur:(ask|ok|kick|list)(?::(\d+))?$/.exec(data)
  if (!m) return false
  if (!isPrimaryOwner(ctx)) {
    await ctx.answerCallbackQuery({ text: 'Удалять пользователей может только владелец.' }).catch(() => {})
    return true
  }
  const [, action, id] = m
  if (action === 'list') {
    await ctx.answerCallbackQuery().catch(() => {})
    await show(ctx, usersScreen(d))
    return true
  }
  if (!id || id === owner()) {
    await ctx.answerCallbackQuery({ text: 'Владельца удалить нельзя.' }).catch(() => {})
    return true
  }
  if (action === 'ask') {
    await ctx.answerCallbackQuery().catch(() => {})
    const s = d.userSession(id)
    await show(ctx, confirmScreen(d, id, s ? `sm:s:${s.id}` : 'ur:list'))
    return true
  }
  if (!loadAccess().allowFrom.includes(id)) {
    await ctx.answerCallbackQuery({ text: 'Уже удалён.' }).catch(() => {})
    return true
  }
  await ctx.answerCallbackQuery({ text: '🚫 Удаляю…' }).catch(() => {})
  const who = label(d, id)
  const done = await removeUser(d, id, { kick: action === 'kick' })
  await show(ctx, { text: [`🚫 <b>${escapeHtml(who)}</b> удалён.`, '', ...done].join('\n'), kb: new InlineKeyboard([[button('« Пользователи', 'ur:list')]]) })
  return true
}
