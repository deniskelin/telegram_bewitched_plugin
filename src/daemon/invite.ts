/**
 * 👥 Invite a user from the bot: the owner picks a contact with Telegram's
 * "share user" keyboard, confirms, and the bot adds them to the allowlist,
 * prepares (and starts) their session, makes a one-person link to the topics
 * group and sends the owner a ready-to-forward invitation.
 */

import { InlineKeyboard, Keyboard, type Bot, type Context } from 'grammy'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { loadAccess, owner, saveAccess } from '../access.ts'
import { settings } from '../config.ts'
import { clip, escapeHtml } from '../format.ts'
import type { Daemon } from './daemon.ts'
import { screenKb, sessionName } from './launch.ts'
import { button } from './stream.ts'

/** Only the first allowlisted user (the owner) invites: everyone added gets full control. */
function isPrimaryOwner(ctx: Context): boolean {
  return ctx.chat?.type === 'private' && !!ctx.from && String(ctx.from.id) === owner()
}

/** Open Telegram's contact picker under the message box. */
async function askForContact(d: Daemon, ctx: Context): Promise<void> {
  const requestId = Math.floor(Math.random() * 2_000_000_000) + 1
  d.store.set(`invite_req:${requestId}`, String(Date.now()))
  const kb = new Keyboard()
    .add({ text: '👤 Выбрать контакт', request_users: { request_id: requestId, user_is_bot: false, max_quantity: 1, request_name: true, request_username: true } })
    .row().text('Отмена').resized().oneTime()
  await ctx.reply('Кого пригласить? Нажмите «👤 Выбрать контакт» под полем ввода и выберите человека.', { reply_markup: kb })
}

type Shared = { id: string; name: string; username: string | null; first?: string; last?: string }

function sharedName(u: { first_name?: string; last_name?: string; username?: string; user_id: number }): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : String(u.user_id))
}

/** After the pick: what will happen, and a confirmation. */
async function confirmInvite(d: Daemon, ctx: Context, u: Shared): Promise<void> {
  const removeKb = { reply_markup: { remove_keyboard: true as const } }
  if (loadAccess().allowFrom.includes(u.id)) {
    await ctx.reply(`${u.name} уже в списке доступа.`, removeKb)
    return
  }
  d.store.set(`invite:${u.id}`, JSON.stringify(u))
  await ctx.reply(`Выбран ${u.name}${u.username ? ` (@${u.username})` : ''}, id ${u.id}.`, removeKb)
  const who = escapeHtml(u.name)
  await ctx.reply([
    `👥 Пригласить <b>${who}</b>?`,
    '',
    'Что сделаю:',
    `• добавлю в список доступа бота (<code>access.json</code>);`,
    settings.userSessions ? `• создам папку <code>${escapeHtml(join(settings.usersDir, u.id))}</code> и запущу его сессию в tmux;` : '• его сообщения будет получать главная сессия (USER_SESSIONS=off);',
    d.topicsChatId ? '• сделаю одноразовую ссылку в группу с топиками;' : '',
    '• пришлю приглашение, которое останется переслать.',
    '',
    '⚠️ Как и все сопряжённые пользователи, он получит полный доступ: свою сессию Claude Code на этом сервере, пульт (/sessions, /topics) и ответы на запросы разрешений.',
  ].filter(Boolean).join('\n'), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard([[button('✅ Пригласить', `inv:ok:${u.id}`, 'success'), button('Отмена', `inv:no:${u.id}`)]]),
  })
}

async function doInvite(d: Daemon, ctx: Context, u: Shared): Promise<void> {
  const a = loadAccess()
  if (!a.allowFrom.includes(u.id)) a.allowFrom.push(u.id)
  // Known before the file changes: the allowlist watcher must not prepare them a second time.
  markKnown(d, [u.id])
  saveAccess(a)
  d.store.set(`user_name:${u.id}`, u.name)
  d.rememberUser(u.id, { first: u.first, last: u.last, username: u.username ?? undefined })
  d.log(`invited user ${u.id} (${u.name})`)
  await ctx.editMessageText(`✅ ${escapeHtml(u.name)} добавлен в список доступа. Готовлю сессию…`, { parse_mode: 'HTML' }).catch(() => {})
  await onUserAdded(d, u.id)
}

/**
 * A user was added to the allowlist (here, by the access skill or by hand):
 * their folder, their session, a one-person group link, and a note to the
 * owner with what is left to do plus an invitation to forward.
 */
export async function onUserAdded(d: Daemon, id: string): Promise<void> {
  const to = owner()
  if (!to || id === to) return
  if (!d.userInfo(id)) {
    const c = await d.bot.api.getChat(Number(id)).catch(() => null)
    if (c?.type === 'private') d.rememberUser(id, { first: c.first_name, last: c.last_name, username: c.username })
  }
  const name = d.userLabel(id)
  const done: string[] = [`👥 <b>${escapeHtml(name)}</b>${name !== id ? ` (id <code>${id}</code>)` : ''} в списке доступа.`]
  let window: string | null = null
  if (settings.userSessions) {
    const dir = join(settings.usersDir, id)
    mkdirSync(dir, { recursive: true })
    done.push(`📁 Папка <code>${escapeHtml(dir)}</code>.`)
    if (!d.userSession(id)) {
      try {
        window = await d.launchSession(dir, { name: sessionName(d, dir) })
        d.launching.set(dir, Date.now())
        done.push(`🚀 Сессия <code>${escapeHtml(sessionName(d, dir) ?? '')}</code> запускается в tmux (окно ${escapeHtml(window)}).`)
      } catch (err) {
        done.push(`⚠️ Сессию запустить не удалось (${escapeHtml(String(err instanceof Error ? err.message : err))}) — она запустится сама по первому сообщению.`)
      }
    }
  }
  let groupLink: string | null = null
  if (d.topicsChatId) {
    groupLink = await d.bot.api.createChatInviteLink(d.topicsChatId, { name: clip(`invite ${name}`, 32), member_limit: 1 })
      .then(l => l.invite_link ?? null, err => { d.log(`invite link failed: ${err}`); return null })
    if (!groupLink) done.push('⚠️ Ссылку в группу сделать не вышло: дайте боту право «Приглашать пользователей» или добавьте человека в группу сами.')
  }

  const steps = ['', '<b>Что сделать вам:</b>']
  let n = 1
  if (window) steps.push(`${n++}. Подтвердите запуск сессии: «👁 Экран и клавиши» ниже → в экране каналов выберите пункт (обычно 1 и Enter).`)
  steps.push(`${n++}. Перешлите ${escapeHtml(name)} приглашение из следующего сообщения.`)
  steps.push(`${n++}. Когда он напишет боту, сообщение уйдёт в его сессию. Убрать доступ: <code>/telegram-bewitched:access remove ${id}</code> в терминале.`)
  await d.bot.api.sendMessage(to, [...done, ...steps].join('\n'), { parse_mode: 'HTML', ...(window ? { reply_markup: screenKb(window) } : {}) })
    .catch(err => d.log(`user-added notice failed: ${err}`))

  const botLink = `https://t.me/${d.botUsername}?start=hello`
  await d.bot.api.sendMessage(to, [
    `Привет! Я дал тебе доступ к своему боту с Claude Code: ${botLink}`,
    'Открой его, нажми «Старт» и пиши как обычному собеседнику — у тебя там своя сессия Claude.',
    ...(groupLink ? [`Группа с топиками проектов: ${groupLink}`] : []),
  ].join('\n'), { link_preview_options: { is_disabled: true } }).catch(err => d.log(`invitation failed: ${err}`))
}

// --------------------------------------------------------------------------
// Allowlist watcher
// --------------------------------------------------------------------------

function knownUsers(d: Daemon): Set<string> | null {
  const raw = d.store.get('known_users')
  return raw ? new Set(JSON.parse(raw) as string[]) : null
}

function markKnown(d: Daemon, ids: string[]): void {
  const known = knownUsers(d) ?? new Set(loadAccess().allowFrom)
  for (const id of ids) known.add(id)
  d.store.set('known_users', JSON.stringify([...known]))
}

/**
 * Users who appeared in allowFrom since the last look. The first look (no
 * record yet) counts only those without a folder in USERS_DIR: users who
 * already worked here are not new.
 */
export function newUsers(d: Daemon): string[] {
  const allow = loadAccess().allowFrom
  const known = knownUsers(d)
  const fresh = known
    ? allow.filter(id => !known.has(id))
    : allow.slice(1).filter(id => settings.userSessions && !existsSync(join(settings.usersDir, id)))
  d.store.set('known_users', JSON.stringify(allow))
  return fresh
}

/** Names for allowlisted users we know only by id (added before names were kept): ask Telegram. */
export async function backfillUserInfo(d: Daemon): Promise<void> {
  for (const id of loadAccess().allowFrom) {
    if (d.userInfo(id)) continue
    const c = await d.bot.api.getChat(Number(id)).catch(() => null)
    if (c?.type === 'private') d.rememberUser(id, { first: c.first_name, last: c.last_name, username: c.username })
  }
}

export function startAllowlistWatch(d: Daemon): void {
  setTimeout(() => void backfillUserInfo(d).catch(err => d.log(`user names: ${err}`)), 2000).unref?.()
  const tick = () => {
    for (const id of newUsers(d)) void onUserAdded(d, id).catch(err => d.log(`user ${id} setup failed: ${err}`))
  }
  setTimeout(tick, 3000).unref?.()
  setInterval(tick, 5000).unref?.()
}

export function registerInviteCommands(d: Daemon, bot: Bot): void {
  bot.command('invite', async ctx => {
    if (!isPrimaryOwner(ctx)) return
    await askForContact(d, ctx)
  })

  bot.on('message:users_shared', async ctx => {
    if (!isPrimaryOwner(ctx)) return
    const shared = ctx.message.users_shared
    if (!d.store.get(`invite_req:${shared.request_id}`)) return
    d.store.set(`invite_req:${shared.request_id}`, null)
    const u = shared.users[0]
    if (!u) return
    await confirmInvite(d, ctx, { id: String(u.user_id), name: sharedName(u), username: u.username ?? null, first: u.first_name, last: u.last_name })
  })

  // "Отмена" on the reply keyboard.
  bot.hears('Отмена', async (ctx, next) => {
    if (!isPrimaryOwner(ctx)) return next()
    await ctx.reply('Отменено.', { reply_markup: { remove_keyboard: true } })
  })
}

/** inv:start (the 👥 button), inv:ok:<id>, inv:no:<id> */
export async function handleInviteCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^inv:(start|ok|no)(?::(\d+))?$/.exec(data)
  if (!m) return false
  if (!isPrimaryOwner(ctx)) {
    await ctx.answerCallbackQuery({ text: ctx.chat?.type === 'private' ? 'Приглашать может только владелец.' : 'Приглашение — в личке с ботом: /invite' }).catch(() => {})
    return true
  }
  await ctx.answerCallbackQuery().catch(() => {})
  if (m[1] === 'start') {
    await askForContact(d, ctx)
    return true
  }
  const raw = d.store.get(`invite:${m[2]}`)
  d.store.set(`invite:${m[2]}`, null)
  if (m[1] === 'no' || !raw) {
    await ctx.editMessageText(raw ? 'Приглашение отменено.' : 'Приглашение уже обработано.').catch(() => {})
    return true
  }
  await doInvite(d, ctx, JSON.parse(raw) as Shared)
  return true
}
