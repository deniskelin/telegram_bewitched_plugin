/**
 * Forum topics in a connected supergroup: one topic per project, a pinned
 * dashboard in General, control commands, and the /connect_group flow that
 * links the supergroup from the bot's DM.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { isOwner, loadAccess, owner, saveAccess, setPref } from '../access.ts'
import { MEMORY_DIR, settings } from '../config.ts'
import type { TopicRow } from '../db.ts'
import { fmtDuration, safeMeta } from '../format.ts'
import { isMessageNotModified, isThreadNotFound, topicLink } from '../tg.ts'
import type { ChatRef, Daemon, Session } from './daemon.ts'
import { button } from './stream.ts'
import { endSession, onManualTopic, startProject } from './launch.ts'

const ARCHIVE_PREFIX = '🗄 '

// --------------------------------------------------------------------------
// Topic binding
// --------------------------------------------------------------------------

function topicKey(s: Session): { key: string; kind: TopicRow['kind'] } {
  return settings.topicMode === 'session'
    ? { key: `${s.projectKey}#${s.id}`, kind: 'session' }
    : { key: s.projectKey, kind: 'project' }
}

function topicName(d: Daemon, chatId: string, s: Session): string {
  if (settings.topicMode === 'session') {
    const t = new Date()
    return `${s.projectName} · ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  }
  // Two projects with the same folder name: add the parent dir.
  const taken = d.store.topics(chatId).some(t => t.name.replace(ARCHIVE_PREFIX, '') === s.projectName && t.project_key !== s.projectKey)
  if (!taken) return s.projectName
  const parts = s.projectKey.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

/** Find or create the session's topic in the topics group. */
export async function ensureTopic(d: Daemon, s: Session): Promise<Session['topic']> {
  const chatId = d.topicsChatId
  if (!chatId || s.passive || settings.topicMode === 'off') return (s.topic = null)
  const { key, kind } = topicKey(s)
  let row = d.store.topicForProject(chatId, key)
  if (row && row.status === 'archived') {
    const name = row.name.replace(ARCHIVE_PREFIX, '')
    const thread = row.thread_id
    try {
      await d.bot.api.reopenForumTopic(chatId, thread).catch(() => {})
      await d.bot.api.editForumTopic(chatId, thread, { name })
      d.store.setTopicStatus(chatId, thread, 'active', name)
      row = d.store.topic(chatId, thread)
    } catch (err) {
      if (isThreadNotFound(err)) {
        d.store.deleteTopic(chatId, thread)
        row = null
      } else throw err
    }
  }
  if (!row) {
    const name = topicName(d, chatId, s)
    const t = await d.bot.api.createForumTopic(chatId, name)
    row = {
      chat_id: chatId,
      thread_id: t.message_thread_id,
      name,
      kind,
      project_key: key,
      status: 'active',
      created_at: Date.now(),
      last_activity_at: Date.now(),
    }
    d.store.upsertTopic(row)
    d.log(`created topic "${name}" (${t.message_thread_id}) for ${key}`)
  }
  s.topic = { chatId, threadId: row!.thread_id, name: row!.name }
  return s.topic
}

/** Where unsolicited messages for a session go: its topic, the last chat, or the owner's DM. */
export function sessionTarget(d: Daemon, s: Session | null): ChatRef | null {
  if (s?.topic) return { chatId: s.topic.chatId, threadId: s.topic.threadId, isPrivate: false }
  if (s?.lastChat) return s.lastChat
  const o = owner()
  return o ? { chatId: o, isPrivate: true } : null
}

/**
 * Send into a session's topic; if the user deleted the topic, recreate it
 * once and retry.
 */
export async function sendToSession<T>(d: Daemon, s: Session | null, fn: (chat: ChatRef) => Promise<T>): Promise<T> {
  const chat = sessionTarget(d, s)
  if (!chat) throw new Error('no chat to send to — pair a Telegram account first')
  try {
    return await fn(chat)
  } catch (err) {
    if (s && s.topic && chat.threadId === s.topic.threadId && isThreadNotFound(err)) {
      d.store.deleteTopic(s.topic.chatId, s.topic.threadId)
      s.topic = null
      await ensureTopic(d, s)
      const again = sessionTarget(d, s)!
      return await fn(again)
    }
    throw err
  }
}

function memoryFile(chatId: string, threadId: number | null | undefined): string {
  return join(MEMORY_DIR, `${chatId}_${threadId ?? 0}.md`)
}

export function readMemory(chatId: string, threadId?: number | null): string | null {
  const f = memoryFile(chatId, threadId)
  return existsSync(f) ? readFileSync(f, 'utf8') : null
}

export function memoryPath(chatId: string, threadId?: number | null): string {
  return memoryFile(chatId, threadId)
}

function fmtTime(sec: number): string {
  const d = new Date(sec * 1000)
  return `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
}

/** On connect: topic, welcome card, and a resume event with memory, recent history and queued messages. */
export async function onSessionRegistered(d: Daemon, s: Session): Promise<void> {
  if (s.passive) return
  try {
    await ensureTopic(d, s)
  } catch (err) {
    d.log(`topic for ${s.projectKey} failed: ${err}`)
  }
  const chat = sessionTarget(d, s)
  if (s.topic) s.lastChat = chat
  if (s.topic && !s.reconnect) {
    const card = [
      '🟢 Сессия подключена',
      `📁 ${s.cwd}`,
      s.branch ? `🌿 ${s.branch}` : null,
      s.tmuxPane ? '⏹ Стоп доступен (tmux)' : '⏹ Стоп недоступен: сессия не в tmux',
    ].filter(Boolean).join('\n')
    await sendToSession(d, s, c => d.bot.api.sendMessage(c.chatId, card, { message_thread_id: c.threadId, disable_notification: true })).catch(() => {})
  }

  const parts: string[] = []
  if (chat && !s.reconnect) {
    const mem = readMemory(chat.chatId, chat.threadId)
    if (mem) parts.push(`Память этого чата (save_memory):\n${mem.trim()}`)
    const hist = d.store.history(chat.chatId, chat.threadId ?? null, settings.resumeLastN)
    if (hist.length) {
      parts.push('Последние сообщения:\n' + hist.map(m =>
        `[${fmtTime(m.date)}] ${m.direction === 'out' ? 'бот' : m.from_name ?? 'пользователь'}: ${m.text.slice(0, 400)}`).join('\n'))
    }
  }
  const pending = d.store.takePending(topicKey(s).key, settings.pendingTtlH)
  if (pending.length) {
    parts.push(`Пока сессия была offline, пришло сообщений: ${pending.length}. Ответь на них:\n` + pending.map(p =>
      `[${new Date(p.created_at).toLocaleString('ru-RU')}] ${p.meta.user ?? 'пользователь'}: ${p.content}`).join('\n'))
  }
  if (parts.length && chat) {
    d.deliver(s, parts.join('\n\n'), {
      event: 'session_resume',
      chat_id: chat.chatId,
      ...(chat.threadId != null ? { thread_id: String(chat.threadId) } : {}),
      ...(s.topic ? { topic_name: safeMeta(s.topic.name) ?? '' } : {}),
      pending_count: String(pending.length),
    }, pending.length ? chat : undefined)
  }
}

export function onSessionGone(d: Daemon, s: Session): void {
  if (!s.topic || s.passive) return
  // Another live session may still serve this topic (TOPIC_MODE=project).
  if (d.activeSessions().some(o => o.topic?.threadId === s.topic!.threadId && o.topic.chatId === s.topic!.chatId)) return
  void d.bot.api.sendMessage(s.topic.chatId, '⚪️ Сессия отключена', { message_thread_id: s.topic.threadId, disable_notification: true }).catch(() => {})
}

// --------------------------------------------------------------------------
// Dashboard (pinned in General)
// --------------------------------------------------------------------------

let dashTimer: ReturnType<typeof setTimeout> | null = null
let dashLast = 0

function statusLabel(s: Session): string {
  if (s.status === 'waiting') return '🟡 ждёт разрешения'
  if (s.status === 'working') return '🔵 работает'
  return '🟢 свободна'
}

export function renderDashboard(d: Daemon): string {
  const list = d.activeSessions().sort((a, b) => a.projectName.localeCompare(b.projectName))
  const lines = ['🎛 Пульт Claude Code', '']
  if (!list.length) lines.push('Нет запущенных сессий.')
  for (const s of list) {
    const ago = fmtDuration(Date.now() - s.lastActivity)
    lines.push(`${statusLabel(s)} · ${s.projectName}${s.branch ? ` (${s.branch})` : ''} — #${s.id}, активность ${ago} назад`)
  }
  lines.push('', `Обновлено ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`, '/sessions · /topics · /help')
  return lines.join('\n')
}

export function scheduleDashboard(d: Daemon): void {
  if (dashTimer) return
  const wait = Math.max(0, dashLast + 10_000 - Date.now())
  dashTimer = setTimeout(() => {
    dashTimer = null
    dashLast = Date.now()
    void updateDashboard(d)
  }, wait)
}

async function updateDashboard(d: Daemon): Promise<void> {
  const chatId = d.topicsChatId
  if (!chatId) return
  const text = renderDashboard(d)
  const id = Number(d.store.get('dashboard_msg_id')) || null
  if (id) {
    try {
      await d.bot.api.editMessageText(chatId, id, text)
      return
    } catch (err) {
      if (isMessageNotModified(err)) return
    }
  }
  try {
    const msg = await d.bot.api.sendMessage(chatId, text, { disable_notification: true })
    d.store.set('dashboard_msg_id', String(msg.message_id))
    await d.bot.api.pinChatMessage(chatId, msg.message_id, { disable_notification: true }).catch(() => {})
  } catch (err) {
    d.log(`dashboard update failed: ${err}`)
  }
}

// --------------------------------------------------------------------------
// Connecting the supergroup
// --------------------------------------------------------------------------

type ConnectState = { owner: string; exp: number; chatId?: string; title?: string }

function getConnect(d: Daemon, code: string): ConnectState | null {
  const raw = d.store.get(`connect:${code}`)
  if (!raw) return null
  const c = JSON.parse(raw) as ConnectState
  return c.exp > Date.now() ? c : null
}

export async function checkGroup(d: Daemon, chatId: string): Promise<{ title: string; problems: string[]; warnings: string[] }> {
  const problems: string[] = []
  const warnings: string[] = []
  const chat = await d.bot.api.getChat(chatId)
  const title = 'title' in chat && chat.title ? chat.title : chatId
  if (chat.type !== 'supergroup') problems.push('это не супергруппа')
  else if (!('is_forum' in chat && chat.is_forum)) problems.push('в группе не включены темы (Настройки группы → Темы)')
  const me = await d.bot.api.getChatMember(chatId, d.botId)
  if (me.status !== 'administrator') problems.push('бот не администратор группы')
  else {
    if (!me.can_manage_topics) problems.push('у бота нет права «Управление темами»')
    if (!me.can_pin_messages) warnings.push('нет права «Закреплять сообщения» — пульт не закрепится')
    if (!me.can_delete_messages) warnings.push('нет права «Удалять сообщения» — сообщения прогресса не будут удаляться')
  }
  return { title, problems, warnings }
}

async function sendConnectCard(d: Daemon, code: string, c: ConnectState): Promise<void> {
  const { title, problems, warnings } = await checkGroup(d, c.chatId!)
  c.title = title
  d.store.set(`connect:${code}`, JSON.stringify(c))
  const warn = warnings.length ? `\n\n⚠️ ${warnings.join('\n⚠️ ')}` : ''
  if (problems.length) {
    await d.bot.api.sendMessage(c.owner, `Группа «${title}» пока не готова:\n• ${problems.join('\n• ')}${warn}\n\nИсправьте и нажмите «Проверить снова».`, {
      reply_markup: new InlineKeyboard([[button('🔄 Проверить снова', `cg:re:${code}`, 'primary')], [button('❌ Отмена', `cg:no:${code}`)]]),
    })
    return
  }
  await d.bot.api.sendMessage(c.owner, `Подключить группу «${title}» для топиков Claude Code?\n\nКаждый проект получит свой топик, в General появится пульт. Писать в сессии и управлять ими смогут все сопряжённые с ботом пользователи (allowlist), остальные участники группы — нет.${warn}`, {
    reply_markup: new InlineKeyboard([[button('✅ Подключить', `cg:ok:${code}`, 'success'), button('❌ Отмена', `cg:no:${code}`)]]),
  })
}

export async function connectGroup(d: Daemon, chatId: string): Promise<void> {
  const a = loadAccess()
  const o = owner(a)
  if (!o) throw new Error('no owner paired')
  const prev = d.topicsChatId
  a.groups[chatId] = { requireMention: false, allowFrom: [], allowPaired: true }
  saveAccess(a)
  d.store.set('topics_chat_id', chatId)
  if (prev !== chatId) d.store.set('dashboard_msg_id', null)
  for (const s of d.activeSessions()) {
    s.topic = null
    await ensureTopic(d, s).catch(err => d.log(`topic for ${s.projectKey} failed: ${err}`))
  }
  dashLast = 0
  scheduleDashboard(d)
}

export function disconnectGroup(d: Daemon): void {
  d.store.set('topics_chat_id', null)
  d.store.set('dashboard_msg_id', null)
  for (const s of d.sessions.values()) s.topic = null
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

function isControlChat(d: Daemon, ctx: Context): boolean {
  if (!ctx.from || !isOwner(ctx.from.id)) return false
  if (ctx.chat?.type === 'private') return true
  return String(ctx.chat?.id) === d.topicsChatId && !ctx.message?.is_topic_message
}

function chatKey(ctx: Context): string {
  const thread = ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined
  return thread != null ? `${ctx.chat!.id}:${thread}` : String(ctx.chat!.id)
}

function threadOf(ctx: Context): number | undefined {
  return ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined
}

/** "name rest" or "\"long name\" rest" */
function splitNameArg(arg: string): [string, string] | null {
  const m = /^\s*(?:"([^"]+)"|(\S+))\s*([\s\S]*)$/.exec(arg)
  return m ? [m[1] ?? m[2], m[3].trim()] : null
}

function topicsListKeyboard(d: Daemon, rows: TopicRow[]): InlineKeyboard {
  const kb: ReturnType<typeof button>[][] = []
  for (const t of rows.slice(0, 20)) {
    const row = [button(`${t.status === 'archived' ? '🗄' : '📁'} ${t.name.replace(ARCHIVE_PREFIX, '')}`.slice(0, 40), `tp:info:${t.thread_id}`)]
    row.push(t.status === 'archived' ? button('↩️', `tp:unar:${t.thread_id}`) : button('🗄', `tp:ar:${t.thread_id}`))
    row.push(button('🗑', `tp:del:${t.thread_id}`, 'danger'))
    kb.push(row)
  }
  return new InlineKeyboard(kb)
}

/** Sessions currently served by a topic. */
function sessionsOfTopic(d: Daemon, chatId: string, threadId: number): Session[] {
  const t = d.store.topic(chatId, threadId)
  return d.activeSessions().filter(s => (s.topic?.chatId === chatId && s.topic.threadId === threadId) || (t?.project_key != null && s.projectKey === t.project_key))
}

/**
 * Archive = close the forum topic, mark it 🗄, and end the sessions working
 * in it (so topic and session state never disagree). Returns sessions that
 * could not be ended (not in tmux).
 */
export async function archiveTopic(d: Daemon, chatId: string, threadId: number, o: { endSessions?: boolean; alreadyClosed?: boolean } = {}): Promise<Session[]> {
  const t = d.store.topic(chatId, threadId)
  if (!t) throw new Error('topic not found')
  const stuck: Session[] = []
  for (const s of sessionsOfTopic(d, chatId, threadId)) {
    if (o.endSessions !== false && !endSession(d, s)) stuck.push(s)
    s.topic = null
  }
  const name = ARCHIVE_PREFIX + t.name.replace(ARCHIVE_PREFIX, '')
  d.store.setTopicStatus(chatId, threadId, 'archived', name)
  await d.bot.api.editForumTopic(chatId, threadId, { name }).catch(() => {})
  if (!o.alreadyClosed) await d.bot.api.closeForumTopic(chatId, threadId).catch(err => d.log(`closeForumTopic failed: ${err}`))
  scheduleDashboard(d)
  return stuck
}

/** Reopen an archived topic; with launch, start a session for its project if none runs. */
export async function unarchiveTopic(d: Daemon, chatId: string, threadId: number, o: { launch?: boolean; alreadyOpen?: boolean } = {}): Promise<void> {
  const t = d.store.topic(chatId, threadId)
  if (!t) throw new Error('topic not found')
  const name = t.name.replace(ARCHIVE_PREFIX, '')
  d.store.setTopicStatus(chatId, threadId, 'active', name)
  if (!o.alreadyOpen) await d.bot.api.reopenForumTopic(chatId, threadId).catch(() => {})
  await d.bot.api.editForumTopic(chatId, threadId, { name }).catch(() => {})
  if (o.launch && t.project_key && !d.sessionForProject(t.project_key) && !t.project_key.includes('#')) {
    await startProject(d, t.project_key, { chatId, threadId }, threadId)
  }
  scheduleDashboard(d)
}

export async function deleteTopic(d: Daemon, chatId: string, threadId: number): Promise<void> {
  await d.bot.api.deleteForumTopic(chatId, threadId)
  d.store.deleteTopic(chatId, threadId)
  for (const s of d.sessions.values()) if (s.topic?.threadId === threadId && s.topic.chatId === chatId) s.topic = null
}

export async function renameTopic(d: Daemon, chatId: string, threadId: number, name: string): Promise<void> {
  const clean = name.trim().slice(0, 128)
  if (!clean) throw new Error('empty topic name')
  await d.bot.api.editForumTopic(chatId, threadId, { name: clean })
  const t = d.store.topic(chatId, threadId)
  if (t) d.store.upsertTopic({ ...t, name: clean, last_activity_at: Date.now() })
  for (const s of d.sessions.values()) if (s.topic?.threadId === threadId) s.topic.name = clean
}

function confirmKb(yes: string, no: string): InlineKeyboard {
  return new InlineKeyboard([[button('✅ Да', yes, 'danger'), button('Отмена', no)]])
}

export function registerTopicCommands(d: Daemon, bot: Bot): void {
  const requireControl = (ctx: Context): boolean => isControlChat(d, ctx)
  const topicsChat = (): string | null => d.topicsChatId

  bot.command('sessions', async ctx => {
    if (!requireControl(ctx)) return
    const list = d.activeSessions()
    if (!list.length) return void ctx.reply('Нет запущенных сессий.')
    const lines: string[] = []
    const kb: ReturnType<typeof button | typeof InlineKeyboard.url>[][] = []
    const dm = d.dmSession()
    for (const s of list) {
      lines.push(`${statusLabel(s)} #${s.id} · ${s.projectName}${s.branch ? ` (${s.branch})` : ''}${s === dm ? ' · 📥 личка' : ''}\n   ${s.cwd}`)
      const row: ReturnType<typeof button | typeof InlineKeyboard.url>[] = []
      const link = s.topic ? topicLink(s.topic.chatId, s.topic.threadId) : null
      if (link) row.push(InlineKeyboard.url(`📂 ${s.projectName}`.slice(0, 40), link))
      if (s.topic) row.push(button('🗄 Архив', `ses:ar:${s.id}`))
      if (s !== dm) row.push(button('📥 В личку', `ses:dm:${s.id}`))
      if (s.tmuxPane && s.status === 'working') row.push(button('⏹', `stop:${s.id}`, 'danger'))
      if (row.length) kb.push(row)
    }
    await ctx.reply(lines.join('\n\n'), { reply_markup: new InlineKeyboard(kb as never) })
  })

  bot.command('topics', async ctx => {
    if (!requireControl(ctx)) return
    const chat = topicsChat()
    if (!chat) return void ctx.reply('Группа для топиков не подключена. В личке с ботом: /connect_group')
    const rows = d.store.topics(chat)
    if (!rows.length) return void ctx.reply('Топиков пока нет.')
    await ctx.reply(`Топики (${rows.length}):`, { reply_markup: topicsListKeyboard(d, rows) })
  })

  bot.command('send', async ctx => {
    if (!requireControl(ctx)) return
    const parsed = splitNameArg(ctx.match ?? '')
    const chat = topicsChat()
    if (!parsed || !parsed[1] || !chat) return void ctx.reply('Формат: /send <топик> <текст>')
    const t = d.store.topicByName(chat, parsed[0])
    if (!t) return void ctx.reply(`Топик «${parsed[0]}» не найден. /topics — список.`)
    const s = d.sessionForThread(chat, t.thread_id)
    const meta = { chat_id: chat, thread_id: String(t.thread_id), user: safeMeta(ctx.from!.username ?? String(ctx.from!.id)) ?? '', user_id: String(ctx.from!.id), ts: new Date().toISOString(), event: 'control_send' }
    if (!s) {
      if (t.project_key) d.store.addPending(t.project_key, parsed[1], meta)
      return void ctx.reply('💤 Сессия не запущена — сообщение доставлю при запуске.')
    }
    d.deliver(s, parsed[1], meta, { chatId: chat, threadId: t.thread_id, isPrivate: false })
    await ctx.reply(`📨 Отправлено в «${t.name}».`)
  })

  bot.command('broadcast', async ctx => {
    if (!requireControl(ctx)) return
    const text = (ctx.match ?? '').trim()
    if (!text) return void ctx.reply('Формат: /broadcast <текст>')
    const id = randomBytes(4).toString('hex')
    d.store.set(`bc:${id}`, text)
    await ctx.reply(`Отправить во все активные сессии (${d.activeSessions().length})?\n\n${text}`, { reply_markup: confirmKb(`bc:ok:${id}`, `bc:no:${id}`) })
  })

  bot.command('rename', async ctx => {
    if (!requireControl(ctx)) return
    const chat = topicsChat()
    const m = /^(.+?)\s*(?:\||→|->)\s*(.+)$/.exec(ctx.match ?? '')
    if (!chat || !m) return void ctx.reply('Формат: /rename <топик> | <новое имя>')
    const t = d.store.topicByName(chat, m[1])
    if (!t) return void ctx.reply(`Топик «${m[1]}» не найден.`)
    await renameTopic(d, chat, t.thread_id, m[2]).then(() => ctx.reply('✏️ Переименовано.'), err => ctx.reply(`Не вышло: ${err.message ?? err}`))
  })

  bot.command('archive', async ctx => {
    if (!requireControl(ctx)) return
    const chat = topicsChat()
    const t = chat ? d.store.topicByName(chat, ctx.match ?? '') : null
    if (!chat || !t) return void ctx.reply('Формат: /archive <топик>')
    await archiveTopic(d, chat, t.thread_id).then(() => ctx.reply('🗄 В архиве.'), err => ctx.reply(`Не вышло: ${err.message ?? err}`))
  })

  bot.command('delete', async ctx => {
    if (!requireControl(ctx)) return
    const chat = topicsChat()
    const t = chat ? d.store.topicByName(chat, ctx.match ?? '') : null
    if (!chat || !t) return void ctx.reply('Формат: /delete <топик>')
    await ctx.reply(`Удалить топик «${t.name}» вместе со всеми сообщениями?`, { reply_markup: confirmKb(`tp:delok:${t.thread_id}`, 'tp:cancel:0') })
  })

  bot.command('use', async ctx => {
    if (ctx.chat?.type !== 'private' || !isOwner(ctx.from!.id)) return
    const id = (ctx.match ?? '').trim().replace(/^#/, '')
    const s = d.sessions.get(id)
    if (!s || s.passive) return void ctx.reply('Сессия не найдена. /sessions — список.')
    d.store.set('dm_session', s.id)
    await ctx.reply(`📥 Сообщения из лички теперь идут в #${s.id} · ${s.projectName}.`)
  })

  bot.command('verbose', async ctx => {
    if (!ctx.from || !isOwner(ctx.from.id)) return
    const v = Number((ctx.match ?? '').trim())
    if (![0, 1, 2].includes(v)) return void ctx.reply('Формат: /verbose 0|1|2\n0 — только «думает» и ответ\n1 — + действия\n2 — + текст модели')
    setPref(chatKey(ctx), { verbose: v as 0 | 1 | 2 })
    await ctx.reply(`Подробность прогресса: ${v}`, { message_thread_id: threadOf(ctx) })
  })

  bot.command('notify_done', async ctx => {
    if (!ctx.from || !isOwner(ctx.from.id)) return
    const v = (ctx.match ?? '').trim()
    if (!['off', 'long', 'always'].includes(v)) return void ctx.reply(`Формат: /notify_done off|long|always\nlong — если ход дольше ${settings.notifyLongSec} с и без ответа`)
    setPref(chatKey(ctx), { notifyDone: v as 'off' | 'long' | 'always' })
    await ctx.reply(`Уведомления о завершении: ${v}`, { message_thread_id: threadOf(ctx) })
  })

  bot.command('forget', async ctx => {
    if (!ctx.from || !isOwner(ctx.from.id)) return
    const thread = threadOf(ctx) ?? 0
    await ctx.reply('Удалить историю этого чата/топика из памяти бота? Сообщения в Telegram останутся.', {
      message_thread_id: threadOf(ctx),
      reply_markup: confirmKb(`fg:ok:${ctx.chat!.id}:${thread}`, 'fg:no:0:0'),
    })
  })

  bot.command('remember', async ctx => {
    if (!ctx.from || !isOwner(ctx.from.id)) return
    const chat = String(ctx.chat!.id)
    const thread = threadOf(ctx)
    const s = thread != null ? d.sessionForThread(chat, thread) : d.dmSession()
    if (!s) return void ctx.reply('Сессия не запущена.', { message_thread_id: thread })
    d.deliver(s, 'Пользователь просит сохранить память этого чата: вызови save_memory с краткой сводкой важного (цели, решения, договорённости, открытые задачи). Предыдущая сводка перезапишется — включи в новую всё нужное из старой.',
      { chat_id: chat, ...(thread != null ? { thread_id: String(thread) } : {}), event: 'remember_request', user_id: String(ctx.from.id), ts: new Date().toISOString() },
      { chatId: chat, threadId: thread, isPrivate: ctx.chat!.type === 'private' })
  })

  // --- group connection (DM only) ---

  bot.command('connect_group', async ctx => {
    if (ctx.chat?.type !== 'private' || !isOwner(ctx.from!.id)) return
    const code = randomBytes(4).toString('hex')
    d.store.set(`connect:${code}`, JSON.stringify({ owner: String(ctx.from!.id), exp: Date.now() + 15 * 60_000 } satisfies ConnectState))
    const url = `https://t.me/${d.botUsername}?startgroup=${code}&admin=manage_topics+delete_messages+pin_messages`
    await ctx.reply(
      'Подключение группы для топиков:\n\n' +
      '1. Создайте супергруппу и включите в ней «Темы» (или возьмите готовую).\n' +
      '2. Нажмите кнопку ниже, выберите группу и подтвердите права администратора.\n' +
      '3. Подтвердите подключение здесь, в личке.\n\nКнопка действует 15 минут.',
      { reply_markup: new InlineKeyboard().url('➕ Добавить бота в группу', url) },
    )
  })

  bot.command('group', async ctx => {
    if (ctx.chat?.type !== 'private' || !isOwner(ctx.from!.id)) return
    const chat = topicsChat()
    if (!chat) return void ctx.reply('Группа не подключена. /connect_group')
    try {
      const { title, problems, warnings } = await checkGroup(d, chat)
      const st = problems.length ? `❌ ${problems.join('; ')}` : '✅ всё в порядке'
      await ctx.reply(`Группа: «${title}» (${chat})\nСостояние: ${st}${warnings.length ? `\n⚠️ ${warnings.join('\n⚠️ ')}` : ''}\nТопиков: ${d.store.topics(chat).length}\n\nВ группе нет нативного стриминга черновиками: прогресс показывается обновляемым сообщением.`,
        { reply_markup: new InlineKeyboard([[button('Отключить группу', 'cg:dis:0', 'danger')]]) })
    } catch (err) {
      await ctx.reply(`Группа ${chat} недоступна: ${err}`)
    }
  })

  bot.command('disconnect_group', async ctx => {
    if (ctx.chat?.type !== 'private' || !isOwner(ctx.from!.id)) return
    if (!topicsChat()) return void ctx.reply('Группа не подключена.')
    await ctx.reply('Отключить группу? Топики и история останутся, сессии вернутся в личку.', { reply_markup: confirmKb('cg:disok:0', 'cg:no:0') })
  })

  // /start <code> arrives in the group right after adding the bot via the startgroup link.
  bot.on('message', async (ctx, next) => {
    const text = ctx.message.text ?? ''
    const m = /^\/start(?:@\w+)?\s+([0-9a-f]{8})$/.exec(text)
    if (!m || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) return next()
    const c = getConnect(d, m[1])
    if (!c || c.owner !== String(ctx.from?.id)) return
    c.chatId = String(ctx.chat.id)
    await ctx.reply('Проверяю группу… Подтвердите подключение в личке с ботом.').catch(() => {})
    await sendConnectCard(d, m[1], c).catch(err => d.log(`connect card failed: ${err}`))
  })

  bot.on('my_chat_member', async ctx => {
    const upd = ctx.myChatMember
    const chatId = String(upd.chat.id)
    const gone = upd.new_chat_member.status === 'left' || upd.new_chat_member.status === 'kicked'
    const o = owner()
    if (gone && chatId === topicsChat()) {
      disconnectGroup(d)
      if (o) void d.bot.api.sendMessage(o, `⚠️ Бота убрали из группы топиков «${'title' in upd.chat ? upd.chat.title : chatId}». Сессии вернулись в личку. /connect_group — подключить заново.`).catch(() => {})
    }
  })

  // Users can create topics by hand; keep the registry in sync.
  bot.on('message:forum_topic_created', async (ctx, next) => {
    const chat = String(ctx.chat.id)
    if (chat === topicsChat() && ctx.from?.id !== d.botId && ctx.message.message_thread_id != null) {
      d.store.upsertTopic({
        chat_id: chat, thread_id: ctx.message.message_thread_id, name: ctx.message.forum_topic_created.name,
        kind: 'manual', project_key: null, status: 'active', created_at: Date.now(), last_activity_at: Date.now(),
      })
      if (ctx.from && isOwner(ctx.from.id)) void onManualTopic(d, chat, ctx.message.message_thread_id, ctx.message.forum_topic_created.name)
    }
    return next()
  })
  bot.on('message:forum_topic_closed', async (ctx, next) => {
    const chat = String(ctx.chat.id)
    const thread = ctx.message.message_thread_id
    if (chat === topicsChat() && thread != null && ctx.from?.id !== d.botId && ctx.from && isOwner(ctx.from.id)) {
      const t = d.store.topic(chat, thread)
      if (t && t.status !== 'archived') {
        const stuck = await archiveTopic(d, chat, thread, { alreadyClosed: true }).catch(() => [])
        if (stuck.length) {
          await d.bot.api.sendMessage(chat, `🗄 Топик в архиве. Сессии ${stuck.map(s => `#${s.id}`).join(', ')} не в tmux — закройте их сами.`, { message_thread_id: thread }).catch(() => {})
        }
      }
    }
    return next()
  })
  bot.on('message:forum_topic_reopened', async (ctx, next) => {
    const chat = String(ctx.chat.id)
    const thread = ctx.message.message_thread_id
    if (chat === topicsChat() && thread != null && ctx.from?.id !== d.botId && ctx.from && isOwner(ctx.from.id)) {
      const t = d.store.topic(chat, thread)
      if (t && t.status === 'archived') await unarchiveTopic(d, chat, thread, { launch: settings.topicProjects !== 'off', alreadyOpen: true }).catch(err => d.log(`unarchive failed: ${err}`))
    }
    return next()
  })
  bot.on('message:forum_topic_edited', async (ctx, next) => {
    const chat = String(ctx.chat.id)
    const name = ctx.message.forum_topic_edited.name
    const thread = ctx.message.message_thread_id
    if (chat === topicsChat() && name && thread != null && ctx.from?.id !== d.botId) {
      const t = d.store.topic(chat, thread)
      if (t) d.store.upsertTopic({ ...t, name, last_activity_at: Date.now() })
    }
    return next()
  })
}

// --------------------------------------------------------------------------
// Callback buttons: ses:*, tp:*, bc:*, cg:*, fg:*
// --------------------------------------------------------------------------

export async function handleTopicCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^(ses|tp|bc|cg|fg):([a-z]+):([^:]*)(?::(\d+))?$/.exec(data)
  if (!m) return false
  const [, ns, action, arg, arg2] = m
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await answer('Нет доступа.')
    return true
  }
  const chat = d.topicsChatId
  const edit = (text: string) => ctx.editMessageText(text).catch(() => {})

  try {
    if (ns === 'ses' && action === 'dm') {
      const s = d.sessions.get(arg)
      if (!s) { await answer('Сессия уже отключена.'); return true }
      d.store.set('dm_session', s.id)
      await answer(`Личка → #${s.id}`)
    } else if (ns === 'ses' && (action === 'ar' || action === 'arok')) {
      const s = d.sessions.get(arg)
      if (!s?.topic) { await answer('Сессия уже отключена или без топика.'); return true }
      if (action === 'ar') {
        await ctx.reply(`Архивировать «${s.topic.name}»? Сессия #${s.id} будет закрыта, топик — закрыт.`, { reply_markup: confirmKb(`ses:arok:${s.id}`, 'tp:cancel:0') })
        await answer()
        return true
      }
      const stuck = await archiveTopic(d, s.topic.chatId, s.topic.threadId)
      await edit(stuck.length ? `🗄 Топик в архиве. Сессию #${s.id} закрыть не смог (не в tmux) — закройте её сами.` : `🗄 В архиве, сессия #${s.id} закрывается.`)
    } else if (ns === 'tp') {
      const thread = Number(arg)
      if (action === 'cancel') await edit('Отменено.')
      else if (!chat) await answer('Группа не подключена.')
      else if (action === 'info') {
        const t = d.store.topic(chat, thread)
        const link = topicLink(chat, thread)
        await answer(t ? `${t.name}\n${t.project_key ?? 'не привязан к проекту'}` : 'Не найден')
        if (link) await ctx.reply(link).catch(() => {})
      } else if (action === 'ar') {
        const live = sessionsOfTopic(d, chat, thread)
        if (live.length) {
          await ctx.reply(`Архивировать топик? Сессии ${live.map(s => `#${s.id}`).join(', ')} будут закрыты.`, { reply_markup: confirmKb(`tp:arok:${thread}`, 'tp:cancel:0') })
          await answer()
          return true
        }
        await archiveTopic(d, chat, thread)
        await answer('🗄 В архиве')
        await ctx.editMessageReplyMarkup({ reply_markup: topicsListKeyboard(d, d.store.topics(chat)) }).catch(() => {})
      } else if (action === 'arok') {
        const stuck = await archiveTopic(d, chat, thread)
        await edit(stuck.length ? '🗄 В архиве. Часть сессий не в tmux — закройте их сами.' : '🗄 В архиве, сессии закрываются.')
      } else if (action === 'unar') {
        await unarchiveTopic(d, chat, thread, { launch: settings.topicProjects !== 'off' })
        await answer('↩️ Восстановлен')
        await ctx.editMessageReplyMarkup({ reply_markup: topicsListKeyboard(d, d.store.topics(chat)) }).catch(() => {})
      } else if (action === 'del') {
        const t = d.store.topic(chat, thread)
        await ctx.reply(`Удалить топик «${t?.name ?? thread}» вместе со всеми сообщениями?`, { reply_markup: confirmKb(`tp:delok:${thread}`, 'tp:cancel:0') })
        await answer()
      } else if (action === 'delok') {
        await deleteTopic(d, chat, thread)
        await edit('🗑 Топик удалён.')
      }
    } else if (ns === 'bc') {
      const text = d.store.get(`bc:${arg}`)
      d.store.set(`bc:${arg}`, null)
      if (action === 'ok' && text) {
        let n = 0
        for (const s of d.activeSessions()) {
          const target = sessionTarget(d, s)
          d.deliver(s, text, { event: 'broadcast', chat_id: target?.chatId ?? '', user_id: String(ctx.from.id), ts: new Date().toISOString() }, target ?? undefined)
          n++
        }
        await edit(`📢 Отправлено в ${n} сесс.`)
      } else await edit('Отменено.')
    } else if (ns === 'cg') {
      if (action === 'no') { await edit('Отменено.'); return true }
      if (action === 'dis') {
        await ctx.reply('Отключить группу? Топики и история останутся, сессии вернутся в личку.', { reply_markup: confirmKb('cg:disok:0', 'cg:no:0') })
        { await answer(); return true }
      }
      if (action === 'disok') {
        disconnectGroup(d)
        { await edit('Группа отключена. Сессии работают через личку.'); return true }
      }
      const c = getConnect(d, arg)
      if (!c?.chatId) { await edit('Ссылка устарела. Начните заново: /connect_group'); return true }
      if (action === 're') {
        await answer('Проверяю…')
        await sendConnectCard(d, arg, c)
      } else if (action === 'ok') {
        const { problems, title } = await checkGroup(d, c.chatId)
        if (problems.length) { await sendConnectCard(d, arg, c); return true }
        await connectGroup(d, c.chatId)
        d.store.set(`connect:${arg}`, null)
        await edit(`✅ Группа «${title}» подключена. Топики проектов: ${d.activeSessions().filter(s => s.topic).length}.`)
      }
    } else if (ns === 'fg') {
      if (action === 'ok') {
        const n = d.store.forgetThread(arg, Number(arg2) || null)
        await edit(`🧹 Удалено записей истории: ${n}.`)
      } else await edit('Отменено.')
    }
  } catch (err) {
    d.log(`callback ${data} failed: ${err}`)
    await answer(`Ошибка: ${err instanceof Error ? err.message : err}`.slice(0, 190))
    return true
  }
  await answer()
  return true
}
