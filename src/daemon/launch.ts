/**
 * New Claude Code sessions from Telegram: a topic created by the owner (or
 * /new_session) becomes a project dir under PROJECTS_DIR, and a session is
 * started there in a new tmux window. The development-channels confirmation
 * screen is left for the user to accept — it is a human-in-the-loop check.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import { isOwner, owner } from '../access.ts'
import { settings } from '../config.ts'
import { escapeHtml } from '../format.ts'
import type { Daemon, Session } from './daemon.ts'
import { button } from './stream.ts'
import { projectTranscriptDir } from './transcript.ts'

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
export type LaunchOptions = { continue?: boolean; resume?: string; name?: string }

/** CLAUDE_LAUNCH_CMD plus -n <name> (a slug) and --resume <id> (ids are checked) or --continue. */
export function launchCommand(o: LaunchOptions = {}): string {
  const base = o.name && /^[\p{L}\p{N}._-]+$/u.test(o.name) ? `${settings.launchCmd} -n ${o.name}` : settings.launchCmd
  if (o.resume && /^[\w-]+$/.test(o.resume)) return `${base} --resume ${o.resume}`
  return o.continue ? `${base} --continue` : base
}

/**
 * Name for the Claude session (-n) and its tmux window: claude-<username> for
 * a user's session, claude-topic-<topic> for a project. Undefined for the
 * main session: it keeps the folder name.
 */
export function sessionName(d: Daemon, dir: string): string | undefined {
  const user = /^(\d+)$/.exec(relative(settings.usersDir, dir))?.[1]
  if (user) return `claude-${slugify(d.userName(user) ?? '') || user}`
  if (dir === d.mainKey()) return undefined
  const chat = d.topicsChatId
  const topic = chat ? d.store.topicForProject(chat, dir) : null
  const slug = slugify((topic?.name ?? basename(dir)).replace(/^🗄 /, ''))
  return slug ? `claude-topic-${slug}` : undefined
}

export async function tmuxLaunch(dir: string, o: LaunchOptions = {}): Promise<string> {
  const sess = settings.tmuxSession
  const name = o.name ?? (slugify(basename(dir)) || 'claude')
  const cmd = launchCommand(o)
  const hasSession = await run(['has-session', '-t', sess]).then(() => true, () => false)
  if (!hasSession) {
    await run(['new-session', '-d', '-s', sess, '-n', name, '-c', dir, cmd])
    return '0'
  }
  return run(['new-window', '-d', '-P', '-F', '#{window_index}', '-t', `${sess}:`, '-n', name, '-c', dir, cmd])
}

/** tail: the last visible lines of the pane (Claude's status line is there). */
export type TmuxLocation = { session: string; window: string; windowName: string; pane: string; tail: string }

/** Session, window and pane of a tmux pane id — what you need to attach from a terminal. */
export async function tmuxLocation(pane: string): Promise<TmuxLocation | null> {
  try {
    const out = await run(['display-message', '-p', '-t', pane, '#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}'])
    const [session, window, windowName, idx] = out.split('\t')
    if (!session) return null
    const tail = await run(['capture-pane', '-p', '-t', pane]).catch(() => '')
    return { session, window, windowName, pane: idx, tail }
  } catch {
    return null
  }
}

async function say(d: Daemon, chatId: string, threadId: number | undefined, html: string, kb?: InlineKeyboard): Promise<void> {
  await d.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', ...(threadId != null ? { message_thread_id: threadId } : {}), ...(kb ? { reply_markup: kb } : {}) })
    .catch(err => d.log(`launch notice failed: ${err}`))
}

/** tmux capture of a pane or window; null when it is gone. Replaced in tests via Daemon. */
export function tmuxCapture(target: string): Promise<string | null> {
  return run(['capture-pane', '-p', '-t', target]).catch(() => null)
}

/** Type text literally into a pane, then Enter. */
export async function tmuxType(target: string, text: string): Promise<void> {
  await run(['send-keys', '-t', target, '-l', text])
  await run(['send-keys', '-t', target, 'Enter'])
}

/** Press keys in a pane or window (tmux key names, e.g. Enter, Escape, 1). */
export async function tmuxKeys(target: string, keys: string[]): Promise<void> {
  for (const k of keys) await run(['send-keys', '-t', target, k])
}

/**
 * End a Claude Code session from outside: interrupt the current turn, then
 * type /exit into its tmux pane. Returns false when the session isn't in tmux.
 */
export function endSession(d: Daemon, s: { id: string; tmuxPane: string | null }): boolean {
  if (!s.tmuxPane) return false
  d.ending.add(s.id) // planned: the watchdog stays quiet
  const pane = s.tmuxPane
  execFile('tmux', ['send-keys', '-t', pane, 'Escape'], () => {
    setTimeout(() => {
      execFile('tmux', ['send-keys', '-t', pane, '-l', '/exit'], () => {
        execFile('tmux', ['send-keys', '-t', pane, 'Enter'], err => { if (err) d.log(`end session ${s.id}: ${err.message}`) })
      })
    }, 700)
  })
  return true
}

// --------------------------------------------------------------------------
// Sessions on demand: a user's DM session, a project topic without a session
// --------------------------------------------------------------------------

const RELAUNCH_MS = 10 * 60_000

type Launch = { ok: true; window: string } | { ok: false; skipped: boolean; error: string }

/** Launch once per dir until that session connects (or RELAUNCH_MS passes). */
async function launchOnce(d: Daemon, dir: string, o: LaunchOptions): Promise<Launch> {
  const at = d.launching.get(dir)
  if (at && Date.now() - at < RELAUNCH_MS) return { ok: false, skipped: true, error: '' }
  d.launching.set(dir, Date.now())
  try {
    return { ok: true, window: await d.launchSession(dir, o) }
  } catch (err) {
    d.launching.delete(dir)
    return { ok: false, skipped: false, error: String(err instanceof Error ? err.message : err) }
  }
}

function hasTranscripts(dir: string): boolean {
  try {
    return readdirSync(projectTranscriptDir(dir)).some(f => f.endsWith('.jsonl'))
  } catch {
    return false
  }
}

function confirmHint(win: string): string {
  return `<pre>tmux attach -t ${escapeHtml(settings.tmuxSession)}:${escapeHtml(win)}</pre>и примите экран подтверждения каналов. Или кнопкой «👁 Экран» — прямо из Telegram.`
}

/** "👁 Экран" for a freshly launched window: its screen with keys to accept the channels prompt. */
export function screenKb(win: string): InlineKeyboard {
  return new InlineKeyboard([[button('👁 Экран и клавиши', `tx:w${win}`, 'primary')]])
}

export function manualCmd(dir: string, o: LaunchOptions = {}): string {
  return `<pre>cd ${escapeHtml(dir)} &amp;&amp; ${escapeHtml(launchCommand(o))}</pre>`
}

/**
 * A DM from a user whose session is not running: start it in USERS_DIR/<id>
 * (continuing the last conversation there). The message is already queued.
 */
export async function launchUserSession(d: Daemon, userId: string, name: string, where: { chatId: string; threadId?: number } = { chatId: userId }): Promise<void> {
  const dir = join(settings.usersDir, userId)
  mkdirSync(dir, { recursive: true })
  const cont = hasTranscripts(dir)
  const r = await launchOnce(d, dir, { continue: cont, name: sessionName(d, dir) })
  const o = owner()
  if (!r.ok && r.skipped) {
    await say(d, where.chatId, where.threadId, '⏳ Ваша сессия уже запускается — сообщение дойдёт, как только она подключится.')
    return
  }
  if (!r.ok) {
    await say(d, where.chatId, where.threadId, `❌ Не удалось запустить вашу сессию: ${escapeHtml(r.error)}\nСообщение сохранено. Запустить вручную:${manualCmd(dir, { continue: cont, name: sessionName(d, dir) })}`)
    if (o && o !== userId) await say(d, o, undefined, `❌ Не удалось запустить сессию пользователя ${escapeHtml(name)} (${userId}): ${escapeHtml(r.error)}${manualCmd(dir, { continue: cont, name: sessionName(d, dir) })}`)
    return
  }
  const self = o === userId
  await say(d, where.chatId, where.threadId, self
    ? `🚀 Запускаю вашу сессию в tmux (окно ${escapeHtml(r.window)}). Сообщение дойдёт, когда она подключится. Подтвердите запуск:${confirmHint(r.window)}`
    : '🚀 Запускаю вашу сессию. Сообщение дойдёт, когда она подключится — запуск подтверждают на сервере, это может занять время.', self ? screenKb(r.window) : undefined)
  if (o && !self) {
    await say(d, o, undefined, `🚀 ${escapeHtml(name)} (${userId}) написал(а) боту — запускаю сессию пользователя в <code>${escapeHtml(dir)}</code>. Подтвердите:${confirmHint(r.window)}`, screenKb(r.window))
  }
}

/**
 * A message in a project topic without a session: start the project's
 * session. If that fails, post the manual command and close the topic until
 * the session connects (ensureTopic reopens it).
 */
export async function launchForTopic(d: Daemon, chatId: string, threadId: number, projectKey: string): Promise<void> {
  const launchable = !projectKey.includes('#') && existsSync(projectKey)
  const r: Launch = launchable ? await launchOnce(d, projectKey, { name: sessionName(d, projectKey) }) : { ok: false, skipped: false, error: 'папки проекта нет' }
  if (!r.ok && r.skipped) {
    await say(d, chatId, threadId, '⏳ Сессия проекта уже запускается — сообщение в очереди.')
    return
  }
  if (r.ok) {
    await say(d, chatId, threadId, `🚀 Запускаю сессию проекта в tmux (окно ${escapeHtml(r.window)}). Сообщение дойдёт, когда она подключится. Подтвердите запуск:${confirmHint(r.window)}`, screenKb(r.window))
    return
  }
  const dir = projectKey.replace(/#.*$/, '')
  await say(d, chatId, threadId, `❌ Не удалось запустить сессию проекта: ${escapeHtml(r.error)}\nСообщение сохранено. Запустите вручную:${manualCmd(dir, { name: sessionName(d, dir) })}Топик закрыт, пока сессия не подключится.`)
  d.store.setTopicStatus(chatId, threadId, 'waiting')
  await d.bot.api.closeForumTopic(chatId, threadId).catch(err => d.log(`closeForumTopic failed: ${err}`))
}

/**
 * Close idle sessions: user sessions after USER_IDLE_MIN, project sessions
 * after PROJECT_IDLE_MIN (0 = never, the default). The next DM or topic
 * message starts them again; the main session is never closed.
 */
export function startIdleCloser(d: Daemon): void {
  const closing = new WeakSet<Session>()
  setInterval(() => {
    for (const s of d.activeSessions()) {
      const role = d.roleOf(s)
      const min = role === 'user' ? settings.userIdleMin : role === 'project' ? settings.projectIdleMin : 0
      if (min <= 0 || s.turn || s.status !== 'idle' || closing.has(s)) continue
      if (Date.now() - s.lastActivity < min * 60_000) continue
      if (endSession(d, s)) {
        closing.add(s)
        d.log(`${role} session ${s.id} idle ${min} min, closing`)
      }
    }
  }, 60_000).unref?.()
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
    win = await d.launchSession(dir, { name: sessionName(d, dir) })
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
    `Затем <code>Ctrl+B</code>, <code>${escapeHtml(win)}</code> — и примите экран подтверждения. Или кнопкой «👁 Экран» — прямо отсюда. После этого сессия подключится к ${bindThread != null ? 'этому топику' : 'новому топику проекта'}.`,
  ].join('\n'), screenKb(win))
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
