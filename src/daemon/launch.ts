/**
 * New Claude Code sessions from Telegram: a topic created by the owner (or
 * /new_session) becomes a project dir under PROJECTS_DIR, and a session is
 * started there in a new tmux window. The development-channels confirmation
 * screen is left for the user to accept — it is a human-in-the-loop check.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { execFile } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { basename, isAbsolute, join, resolve } from 'path'
import { isOwner } from '../access.ts'
import { settings } from '../config.ts'
import { escapeHtml } from '../format.ts'
import type { Daemon } from './daemon.ts'
import { button } from './stream.ts'

/** Folder name from a topic name: letters/digits (any script), dot, dash, underscore. */
export function slugify(name: string): string {
  return name
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/^[.-]+/, '')
    .slice(0, 64)
}

/** Absolute project path for a name or path; refuses anything outside PROJECTS_DIR unless absolute. */
export function projectPath(arg: string): string | null {
  const raw = arg.trim()
  if (!raw) return null
  if (isAbsolute(raw) || raw.startsWith('~/')) {
    const p = resolve(raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw)
    return p.includes('\0') ? null : p
  }
  const slug = slugify(raw)
  return slug ? join(settings.projectsDir, slug) : null
}

function run(args: string[]): Promise<string> {
  return new Promise((res, rej) => execFile('tmux', args, { timeout: 5000 }, (err, out) => (err ? rej(err) : res(String(out).trim()))))
}

/**
 * Start `claude` in `dir` in a new window of the tmux session (created if
 * missing). Returns the window index. The command line comes from settings,
 * never from chat input; the dir is passed as an argument, not through a shell.
 */
export async function tmuxLaunch(dir: string): Promise<string> {
  const sess = settings.tmuxSession
  const name = slugify(basename(dir)) || 'claude'
  const hasSession = await run(['has-session', '-t', sess]).then(() => true, () => false)
  if (!hasSession) {
    await run(['new-session', '-d', '-s', sess, '-n', name, '-c', dir, settings.launchCmd])
    return '0'
  }
  return run(['new-window', '-d', '-P', '-F', '#{window_index}', '-t', `${sess}:`, '-n', name, '-c', dir, settings.launchCmd])
}

async function say(d: Daemon, chatId: string, threadId: number | undefined, html: string): Promise<void> {
  await d.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', ...(threadId != null ? { message_thread_id: threadId } : {}) }).catch(err => d.log(`launch notice failed: ${err}`))
}

/** Create the dir (if needed), bind it to the topic, start the session, tell the user where to confirm. */
export async function startProject(d: Daemon, dir: string, where: { chatId: string; threadId?: number }, bindThread?: number): Promise<void> {
  const created = !existsSync(dir)
  mkdirSync(dir, { recursive: true })
  const chat = d.topicsChatId
  if (chat && bindThread != null) {
    const t = d.store.topic(chat, bindThread)
    d.store.upsertTopic({
      chat_id: chat, thread_id: bindThread, name: t?.name ?? basename(dir), kind: 'project', project_key: dir,
      status: 'active', created_at: t?.created_at ?? Date.now(), last_activity_at: Date.now(),
    })
  }
  if (d.sessionForProject(dir)) {
    await say(d, where.chatId, where.threadId, `📁 <code>${escapeHtml(dir)}</code> уже открыт в сессии — пишите сюда.`)
    return
  }
  let win: string
  try {
    win = await d.launchSession(dir)
  } catch (err) {
    await say(d, where.chatId, where.threadId, `❌ Не удалось запустить сессию в tmux: ${escapeHtml(String(err instanceof Error ? err.message : err))}`)
    return
  }
  const sess = settings.tmuxSession
  await say(d, where.chatId, where.threadId, [
    `🚀 ${created ? 'Создал проект' : 'Проект'} <code>${escapeHtml(dir)}</code>, запускаю Claude в tmux: окно ${escapeHtml(win)}.`,
    '',
    'Подтвердите запуск каналов в терминале:',
    `<pre>tmux attach -t ${escapeHtml(sess)}</pre>`,
    `Затем <code>Ctrl+B</code>, <code>${escapeHtml(win)}</code> — и примите экран подтверждения. После этого сессия подключится к ${bindThread != null ? 'этому топику' : 'новому топику проекта'}.`,
  ].join('\n'))
}

/** Owner created a topic by hand → offer/start a project named after it. */
export async function onManualTopic(d: Daemon, chatId: string, threadId: number, name: string): Promise<void> {
  const mode = settings.topicProjects
  if (mode === 'off') return
  const dir = projectPath(name)
  if (!dir) return
  const other = d.store.topicForProject(chatId, dir)
  if (other && other.thread_id !== threadId && other.status === 'active') {
    await say(d, chatId, threadId, `📁 Проект <code>${escapeHtml(dir)}</code> уже привязан к топику «${escapeHtml(other.name)}». Этот топик оставляю без проекта.`)
    return
  }
  if (mode === 'ask') {
    await d.bot.api.sendMessage(chatId, `Создать проект ${dir} и запустить в нём сессию Claude?`, {
      message_thread_id: threadId,
      reply_markup: new InlineKeyboard([[button('🚀 Создать', `np:ok:${threadId}`, 'success'), button('Не надо', `np:no:${threadId}`)]]),
    }).catch(err => d.log(`project offer failed: ${err}`))
    return
  }
  await startProject(d, dir, { chatId, threadId }, threadId)
}

export async function handleLaunchCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^np:(ok|no):(\d+)$/.exec(data)
  if (!m) return false
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: 'Нет доступа.' }).catch(() => {})
    return true
  }
  await ctx.answerCallbackQuery().catch(() => {})
  const chat = d.topicsChatId
  const thread = Number(m[2])
  if (m[1] === 'no' || !chat) {
    await ctx.editMessageText('Ок, без проекта.').catch(() => {})
    return true
  }
  const t = d.store.topic(chat, thread)
  const dir = t ? projectPath(t.name) : null
  await ctx.editMessageReplyMarkup().catch(() => {})
  if (dir) await startProject(d, dir, { chatId: chat, threadId: thread }, thread)
  return true
}

export function registerLaunchCommands(d: Daemon, bot: Bot): void {
  bot.command('new_session', async ctx => {
    if (!ctx.from || !isOwner(ctx.from.id)) return
    const inControl = ctx.chat.type === 'private' || (String(ctx.chat.id) === d.topicsChatId && !ctx.message?.is_topic_message)
    if (!inControl) return
    const dir = projectPath(ctx.match ?? '')
    if (!dir) return void ctx.reply('Формат: /new_session <имя проекта или путь>\nИмя → папка в ' + settings.projectsDir)
    await startProject(d, dir, { chatId: String(ctx.chat.id) })
  })
}
