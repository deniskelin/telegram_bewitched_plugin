/**
 * Inbound Telegram traffic: access gate, routing to the right session,
 * reply/quote/forward enrichment, forward batching, permission relay and the
 * callback-button dispatcher.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import type { Message, ReactionTypeEmoji } from 'grammy/types'
import { execFile } from 'child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { can, dmCommandGate, gate, loadAccess, owner, prefsFor, roleOf } from '../access.ts'
import { APPROVED_DIR, INBOX_DIR, settings } from '../config.ts'
import { clip, safeMeta } from '../format.ts'
import { toWav16k } from '../voice/audio.ts'
import { sttEnabled, transcribe, type SttResult } from '../voice/stt.ts'
import { downloadToInbox } from './media.ts'
import { closeByTextReply, handleQuestionCallback } from './buttons.ts'
import { MAIN_PENDING_KEY, userPendingKey, type ChatRef, type Daemon, type Session } from './daemon.ts'
import { button } from './stream.ts'
import { handleTopicCallback, sessionTarget } from './topics.ts'
import { handleLaunchCallback, launchForTopic, launchUserSession } from './launch.ts'
import { handleWatchdogCallback } from './watchdog.ts'
import { handleTokensCallback } from './outoftokens.ts'
import { digestReport, handleResetCallback, usageKeyboard, usageReport } from './usage.ts'
import { handleSessionMenu } from './menu.ts'
import { handleScreenCallback } from './screen.ts'
import { handleReminderCallback, registerReminderCommands } from './reminders.ts'
import { handleReportCallback, registerReportCommands } from './reports.ts'
import { handleInviteCallback, registerInviteCommands } from './invite.ts'
import { handleUserCallback, registerUserCommands } from './users.ts'
import { handleTopicMenu } from './topicmenu.ts'
import { handleCiCallback } from './events.ts'
import { askOwnerAboutGroup, groupBinding, groupPendingKey, handleGroupCallback, isProjectGroup, launchForGroup, registerGroupHandlers } from './groups.ts'
import { handleMacroCallback, registerMacroCommands } from './macros.ts'
import { addProjectRule, projectRules } from './permrules.ts'
import { handleServerCallback, registerServerCommands } from './server.ts'
import { handleHubCallback, helpScreen, registerHubCommands } from './hub.ts'
import { t as tr } from '../i18n/index.ts'
import { projectTitle } from './report.ts'

// Permission-reply spec from Claude Code: 5 letters a-z minus 'l'.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

type AttachmentMeta = { kind: string; file_id: string; size?: number; mime?: string; name?: string; duration?: number }

function originLabel(o: NonNullable<Message['forward_origin']>): string {
  switch (o.type) {
    case 'user': return `user:${[o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ')}${o.sender_user.username ? ` @${o.sender_user.username}` : ''}`
    case 'hidden_user': return `hidden_user:${o.sender_user_name}`
    case 'chat': return `chat:${'title' in o.sender_chat ? o.sender_chat.title : o.sender_chat.id}`
    case 'channel': return `channel:${o.chat.title}`
  }
}

/** reply_to / quote / forward / external_reply → meta attributes. */
export function enrichMeta(d: Daemon, msg: Message): Record<string, string> {
  const meta: Record<string, string> = {}
  const chatId = String(msg.chat.id)
  const r = msg.reply_to_message
  // In forum topics every message "replies" to the topic's creation message — skip that.
  if (r && !(msg.is_topic_message && r.message_id === msg.message_thread_id)) {
    meta.reply_to_message_id = String(r.message_id)
    meta.reply_to_from = r.from?.id === d.botId ? 'bot' : safeMeta(r.from?.username ?? r.from?.first_name) ?? 'unknown'
    const text = r.text ?? r.caption ?? d.store.getMessage(chatId, r.message_id)?.text
    const t = safeMeta(text)
    if (t) meta.reply_to_text = t
  }
  if (msg.quote?.text) meta.quote_text = safeMeta(msg.quote.text) ?? ''
  if (msg.forward_origin) {
    meta.forward_from = safeMeta(originLabel(msg.forward_origin), 120) ?? ''
    meta.forward_date = new Date(msg.forward_origin.date * 1000).toISOString()
  }
  if (msg.external_reply) {
    meta.external_reply_from = safeMeta(originLabel(msg.external_reply.origin), 120) ?? ''
  }
  return meta
}

type Target =
  /** fallback: a topic without a project, handled by the main session. */
  | { kind: 'session'; session: Session; projectKey?: string; fallback?: boolean }
  | { kind: 'offline'; projectKey: string }
  | { kind: 'launch'; projectKey: string; threadId: number }
  | { kind: 'waiting'; projectKey: string }
  | { kind: 'user_offline'; userId: string }
  | { kind: 'main_offline' }
  | { kind: 'unbound' }
  | { kind: 'archived'; projectKey: string | null; threadId: number }
  /** An ordinary group the owner hasn't decided about yet (groups.ts). */
  | { kind: 'group_unbound'; chatId: string }
  /** An ordinary group's project without a running session. */
  | { kind: 'group_launch'; chatId: string; projectKey: string }

function resolveTarget(d: Daemon, chat: ChatRef, fromId: string): Target {
  const main = d.mainSession()
  const { chatId, threadId } = chat
  if (d.isTopicsChat(chatId) && threadId != null) {
    const t = d.store.topic(chatId, threadId)
    if (t?.status === 'archived') return { kind: 'archived', projectKey: t.project_key, threadId }
    const s = d.sessionForThread(chatId, threadId)
    if (s) return { kind: 'session', session: s, projectKey: t?.project_key ?? undefined }
    if (t?.project_key) {
      if (t.status === 'waiting') return { kind: 'waiting', projectKey: t.project_key }
      const mode = settings.topicNoSession
      if (mode === 'launch') return { kind: 'launch', projectKey: t.project_key, threadId }
      if (mode === 'main' && main) return { kind: 'session', session: main, projectKey: t.project_key, fallback: true }
      return { kind: 'offline', projectKey: t.project_key }
    }
    // A topic without a project: the author's own session (or the main one without user sessions).
    if (settings.userSessions) return userTarget(d, fromId)
    if (main) return { kind: 'session', session: main, fallback: true }
    return { kind: 'unbound' }
  }
  // An ordinary group: its project's session, or ask the owner what it is.
  if (!chat.isPrivate && isProjectGroup(d, chatId)) {
    const g = groupBinding(d, chatId)
    if (!g) return { kind: 'group_unbound', chatId }
    if (g.dir) {
      const s = d.sessionForProject(g.dir)
      return s ? { kind: 'session', session: s, projectKey: g.dir } : { kind: 'group_launch', chatId, projectKey: g.dir }
    }
  }
  // DMs and General: the author's own session; without user sessions, the main one.
  if (settings.userSessions && (chat.isPrivate || d.isTopicsChat(chatId))) return userTarget(d, fromId)
  return main ? { kind: 'session', session: main } : { kind: 'main_offline' }
}

/**
 * Text that did not come from a Telegram message (a reminder): same routing
 * as a message — the serving session, else queue and start it if we can.
 */
export async function routeText(d: Daemon, chat: ChatRef, fromId: string, text: string, meta: Record<string, string>): Promise<void> {
  const target = resolveTarget(d, chat, fromId)
  switch (target.kind) {
    case 'session':
      if (target.fallback && target.projectKey) d.store.addPending(target.projectKey, text, { ...meta, handled_by: 'main' })
      return d.deliver(target.session, text, meta, chat)
    case 'launch':
      d.store.addPending(target.projectKey, text, meta)
      return launchForTopic(d, chat.chatId, target.threadId, target.projectKey)
    case 'user_offline':
      d.store.addPending(userPendingKey(target.userId), text, meta)
      return launchUserSession(d, target.userId, d.userLabel(target.userId), { chatId: chat.chatId, threadId: chat.threadId })
    case 'offline':
    case 'waiting':
      d.store.addPending(target.projectKey, text, meta)
      return
    case 'main_offline':
      d.store.addPending(MAIN_PENDING_KEY, text, meta)
      return
    case 'archived':
      if (target.projectKey) d.store.addPending(target.projectKey, text, meta)
      return
    case 'unbound':
      return
    case 'group_unbound':
      d.store.addPending(groupPendingKey(target.chatId), text, meta)
      return void askOwnerAboutGroup(d, target.chatId).catch(err => d.log(`group card failed: ${err}`))
    case 'group_launch':
      d.store.addPending(target.projectKey, text, meta)
      return launchForGroup(d, target.chatId, target.projectKey)
  }
}

function userTarget(d: Daemon, userId: string): Target {
  const s = d.userSession(userId)
  return s ? { kind: 'session', session: s } : { kind: 'user_offline', userId }
}

// --- speech to text ---

function isSpeech(kind: string): boolean {
  return kind === 'voice' || kind === 'audio' || kind === 'video_note' || (kind === 'video' && settings.sttVideo)
}

/** Download, convert to 16 kHz WAV, transcribe; the temporary WAV is removed. */
async function speechToText(d: Daemon, a: AttachmentMeta): Promise<SttResult | { error: string }> {
  if (a.duration != null && a.duration > settings.sttMaxSec) return { error: tr('длиннее STT_MAX_SEC ({sttMaxSec} с)', { sttMaxSec: settings.sttMaxSec }) }
  let wav: string | null = null
  try {
    const src = await downloadToInbox(d, a.file_id)
    wav = `${src}.16k.wav`
    await toWav16k(src, wav, settings.sttMaxSec)
    return await transcribe(wav)
  } catch (err) {
    d.log(`stt failed: ${err}`)
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (wav) rmSync(wav, { force: true })
  }
}

// --- forward batching: several forwards within 3 s become one event ---

type Batch = { items: { text: string; meta: Record<string, string> }[]; timer: ReturnType<typeof setTimeout>; ctx: Context; chat: ChatRef }
const batches = new Map<string, Batch>()

async function handleInbound(
  d: Daemon,
  ctx: Context,
  original: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  let text = original
  const result = gate(ctx, d.botUsername)
  if (result.action === 'drop') return
  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram-bewitched:access pair ${result.code}`)
    return
  }

  const access = result.access
  const msg = ctx.message!
  const from = ctx.from!
  const chatId = String(ctx.chat!.id)
  const threadId = msg.is_topic_message ? msg.message_thread_id : undefined
  const isPrivate = ctx.chat!.type === 'private'
  const chat: ChatRef = { chatId, threadId, isPrivate }

  d.store.addMessage({
    chat_id: chatId, thread_id: threadId ?? null, message_id: msg.message_id, direction: 'in',
    from_id: String(from.id), from_name: from.username ?? from.first_name, date: msg.date, text,
    kind: attachment?.kind ?? (downloadImage ? 'photo' : 'text'), file_id: attachment?.file_id ?? null,
    reply_to: msg.reply_to_message?.message_id ?? null, quote: msg.quote?.text ?? null,
    forward: msg.forward_origin ? JSON.stringify(msg.forward_origin) : null,
  })
  if (threadId != null) d.store.touchTopic(chatId, threadId)
  d.lastSpeech.set(`${chatId}:${threadId ?? 0}`, !!attachment && isSpeech(attachment.kind))
  d.rememberUser(String(from.id), { first: from.first_name, last: from.last_name, username: from.username })

  // Permission reply typed as text ("yes abcde").
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch && can(from.id, 'permissions')) {
    const request_id = permMatch[2]!.toLowerCase()
    const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
    resolvePermission(d, request_id, behavior)
    void d.bot.api.setMessageReaction(chatId, msg.message_id, [{ type: 'emoji', emoji: (behavior === 'allow' ? '✅' : '❌') as ReactionTypeEmoji['emoji'] }]).catch(() => {})
    return
  }

  const target = resolveTarget(d, chat, String(from.id))
  const reply = (t: string, kb?: InlineKeyboard) => ctx.reply(t, { message_thread_id: threadId, reply_markup: kb }).catch(() => {})
  // Unknown commands in General are not for Claude.
  if (d.isTopicsChat(chatId) && threadId == null && text.startsWith('/')) return
  if (target.kind === 'unbound') {
    await reply(tr('Этот топик не привязан к проекту, а главная сессия не запущена.'))
    return
  }
  if (target.kind === 'archived') {
    if (target.projectKey) d.store.addPending(target.projectKey, text, { chat_id: chatId, thread_id: String(threadId), user: safeMeta(from.username ?? String(from.id)) ?? '', user_id: String(from.id), ts: new Date(msg.date * 1000).toISOString() })
    await reply(tr('🗄 Топик в архиве. Сообщение сохранил — оно дойдёт до сессии после восстановления.'), new InlineKeyboard([[button(tr('▶️ Восстановить'), `tp:unar:${target.threadId}`, 'success')]]))
    return
  }
  if (access.ackReaction) {
    void d.bot.api.setMessageReaction(chatId, msg.message_id, [{ type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] }]).catch(() => {})
  }

  const imagePath = downloadImage ? await downloadImage() : undefined
  // Speech → text before Claude sees it (after the access check, like photos).
  let sttMeta: Record<string, string> = {}
  if (attachment && isSpeech(attachment.kind) && sttEnabled()) {
    const caption = msg.caption?.trim() ?? ''
    if (access.ackReaction) void d.bot.api.setMessageReaction(chatId, msg.message_id, [{ type: 'emoji', emoji: '✍' }]).catch(() => {})
    const r = await speechToText(d, attachment)
    if ('error' in r) sttMeta = { stt_error: safeMeta(r.error) ?? 'error' }
    else if (!r.text.trim() && !caption) {
      // Nothing was said (a muted mic, a pocket recording): tell the sender, don't bother the session.
      d.store.updateMessageText(chatId, msg.message_id, tr('🎤 (в записи нет речи)'))
      await ctx.reply(tr('🎤 В записи нет речи — похоже, микрофон был выключен. Запишите ещё раз или напишите текстом.'), { reply_parameters: { message_id: msg.message_id }, message_thread_id: threadId }).catch(() => {})
      if (access.ackReaction) void d.bot.api.setMessageReaction(chatId, msg.message_id, []).catch(() => {})
      return
    } else {
      text = caption ? `${caption}\n\n🎤 ${r.text}` : `🎤 ${r.text}`
      d.store.updateMessageText(chatId, msg.message_id, text)
      sttMeta = {
        voice_transcribed: 'true', stt_provider: r.provider,
        ...(attachment.duration != null ? { voice_duration: String(attachment.duration) } : {}),
        ...(r.language ? { voice_language: r.language } : {}),
      }
      if (prefsFor(chatId, threadId).transcript) {
        void ctx.reply(`🎤 ${r.text || tr('(в записи нет речи)')}`.slice(0, 4000), { reply_parameters: { message_id: msg.message_id }, message_thread_id: threadId }).catch(() => {})
      }
    }
    if (access.ackReaction) void d.bot.api.setMessageReaction(chatId, msg.message_id, [{ type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] }]).catch(() => {})
  }
  const questionId = closeByTextReply(d, chatId, msg.reply_to_message?.message_id)
  const meta: Record<string, string> = {
    chat_id: chatId,
    message_id: String(msg.message_id),
    user: safeMeta(from.username ?? String(from.id)) ?? String(from.id),
    user_id: String(from.id),
    // FR-4: who is writing — the model weighs instructions by it.
    user_role: roleOf(String(from.id)) ?? 'guest',
    ts: new Date(msg.date * 1000).toISOString(),
    ...(threadId != null ? { thread_id: String(threadId) } : {}),
    ...(threadId != null && d.store.topic(chatId, threadId) ? { topic_name: safeMeta(d.store.topic(chatId, threadId)!.name) ?? '' } : {}),
    ...enrichMeta(d, msg),
    ...(questionId ? { question_id: questionId } : {}),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...sttMeta,
    ...(attachment ? {
      attachment_kind: attachment.kind,
      attachment_file_id: attachment.file_id,
      ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
      ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
      ...(attachment.name ? { attachment_name: attachment.name } : {}),
    } : {}),
  }

  if (target.kind === 'group_unbound') {
    d.store.addPending(groupPendingKey(chatId), text, meta)
    const asked = await askOwnerAboutGroup(d, chatId, 'title' in ctx.chat! ? ctx.chat.title : undefined).catch(() => false)
    if (asked) await reply(tr('⏳ Владелец ещё не настроил эту группу — сообщение сохранено и дойдёт, когда он решит.'))
    return
  }
  if (target.kind === 'group_launch') {
    d.store.addPending(target.projectKey, text, meta)
    void launchForGroup(d, chatId, target.projectKey).catch(err => d.log(`group launch failed: ${err}`))
    return
  }
  if (target.kind === 'offline') {
    d.store.addPending(target.projectKey, text, meta)
    await reply(tr('💤 Сессия этого проекта не запущена. Сообщение доставлю, когда она подключится.'))
    return
  }
  if (target.kind === 'main_offline') {
    d.store.addPending(MAIN_PENDING_KEY, text, meta)
    await reply(tr('💤 Главная сессия не запущена (папка {v}). Сообщение доставлю, когда она подключится.', { v: d.mainKey() }))
    return
  }
  if (target.kind === 'user_offline') {
    d.store.addPending(userPendingKey(target.userId), text, meta)
    void launchUserSession(d, target.userId, d.userLabel(target.userId), { chatId, threadId }).catch(err => d.log(`user launch failed: ${err}`))
    return
  }
  if (target.kind === 'launch') {
    d.store.addPending(target.projectKey, text, meta)
    void launchForTopic(d, chatId, target.threadId, target.projectKey).catch(err => d.log(`topic launch failed: ${err}`))
    return
  }
  if (target.kind === 'waiting') {
    d.store.addPending(target.projectKey, text, meta)
    // 🚀 only for whoever may press it: a member would get «Нет доступа».
    const run = ctx.from && can(ctx.from.id, 'control') ? new InlineKeyboard([[button(tr('🚀 Запустить'), `wd:topic:${threadId}`, 'success')]]) : undefined
    await reply(tr('⏳ Сессия проекта не подключена — сообщение в очереди.'), run)
    return
  }
  // The project session will see what the main session answered for it.
  if (target.fallback && target.projectKey) d.store.addPending(target.projectKey, text, { ...meta, handled_by: 'main' })

  if (msg.forward_origin) {
    const key = `${chatId}:${threadId ?? 0}:${from.id}`
    const b = batches.get(key)
    if (b) {
      b.items.push({ text, meta })
      clearTimeout(b.timer)
      b.timer = setTimeout(() => flushBatch(d, key), 3000)
    } else {
      batches.set(key, { items: [{ text, meta }], ctx, chat, timer: setTimeout(() => flushBatch(d, key), 3000) })
    }
    return
  }

  d.deliver(target.session, text, meta, chat)
}

function flushBatch(d: Daemon, key: string): void {
  const b = batches.get(key)
  if (!b) return
  batches.delete(key)
  const target = resolveTarget(d, b.chat, String(b.ctx.from?.id ?? ''))
  if (target.kind !== 'session') return
  if (b.items.length === 1) return d.deliver(target.session, b.items[0].text, b.items[0].meta, b.chat)
  // i18n-ignore: for the model
  const content = `Переслано сообщений: ${b.items.length}\n\n` + b.items.map((it, i) =>
    `${i + 1}. [${it.meta.forward_from ?? '?'}${it.meta.forward_date ? `, ${it.meta.forward_date}` : ''}] ${it.text}`).join('\n\n')
  const last = b.items[b.items.length - 1].meta
  d.deliver(target.session, content, { ...last, forward_count: String(b.items.length) }, b.chat)
}

// --- permission relay ---

export function resolvePermission(d: Daemon, request_id: string, behavior: 'allow' | 'deny'): boolean {
  const p = d.permissions.get(request_id)
  if (!p) return false
  d.permissions.delete(request_id)
  const s = d.sessions.get(p.sessionId)
  if (!s) return false
  d.send(s, { t: 'perm', request_id, behavior })
  s.status = 'working'
  d.onSessionsChanged()
  return true
}

export function handlePermissionRequest(d: Daemon, s: Session, p: { request_id: string; tool_name: string; description: string; input_preview: string }): void {
  d.permissions.set(p.request_id, { sessionId: s.id, tool_name: p.tool_name, description: p.description, input_preview: p.input_preview })
  if (s.alwaysAllow.has(p.tool_name) || projectRules(d, s.projectKey).includes(p.tool_name)) {
    d.log(`session ${s.id}: ${p.tool_name} allowed (♾/📌)`)
    resolvePermission(d, p.request_id, 'allow')
    return
  }
  s.status = 'waiting'
  d.onSessionsChanged()
  const text = `🔐 ${projectTitle(s)}: ${p.tool_name}`
  const kb = permissionKb(p.request_id, p.tool_name, true)
  const mode = settings.permissionsTo
  const toTopic = (mode === 'topic' || mode === 'both') && s.topic && d.topicsGroupIsStrict(s.topic.chatId)
  const toDm = mode === 'dm' || mode === 'both' || !toTopic
  if (toTopic) void d.bot.api.sendMessage(s.topic!.chatId, text, { message_thread_id: s.topic!.threadId, reply_markup: kb }).catch(err => d.log(`permission → topic failed: ${err}`))
  // A user's session asks only that user.
  const user = d.userIdOf(s)
  // A group's project asks only the owner: group members don't see or answer it.
  // FR-4: only the owner approves permissions.
  const dmTo = [owner()].filter((x): x is string => !!x)
  if (toDm) for (const chat of dmTo) void d.bot.api.sendMessage(chat, text, { reply_markup: kb }).catch(err => d.log(`permission → ${chat} failed: ${err}`))
}

function permissionKb(requestId: string, tool: string, more: boolean): InlineKeyboard {
  const first = [button(tr('✅ Разрешить'), `perm:allow:${requestId}`, 'success'), button(tr('❌ Запретить'), `perm:deny:${requestId}`, 'danger')]
  if (more) first.unshift(button(tr('Подробнее'), `perm:more:${requestId}`))
  return new InlineKeyboard([first, [button(clip(tr('♾ Всегда {tool} в этой сессии', { tool }), 40), `perm:always:${requestId}`)], [button(clip(tr('📌 Всегда {tool} в проекте', { tool }), 40), `perm:proj:${requestId}`)]])
}

async function handlePermissionCallback(d: Daemon, ctx: Context, data: string): Promise<void> {
  const m = /^perm:(allow|deny|more|always|proj):([a-km-z]{5})$/.exec(data)
  if (!m) return void ctx.answerCallbackQuery().catch(() => {})
  if (!can(ctx.from!.id, 'permissions')) return void ctx.answerCallbackQuery({ text: tr('Разрешения одобряет только владелец.') }).catch(() => {})
  const [, behavior, request_id] = m
  if (behavior === 'more') {
    const p = d.permissions.get(request_id)
    if (!p) return void ctx.answerCallbackQuery({ text: tr('Подробности уже недоступны.') }).catch(() => {})
    let pretty: string
    try {
      pretty = JSON.stringify(JSON.parse(p.input_preview), null, 2)
    } catch {
      pretty = p.input_preview
    }
    const expanded = `🔐 ${p.tool_name}\n\n${p.description}\n\n${pretty}`.slice(0, 4000)
    await ctx.editMessageText(expanded, { reply_markup: permissionKb(request_id, p.tool_name, false) }).catch(() => {})
    return void ctx.answerCallbackQuery().catch(() => {})
  }
  const p = d.permissions.get(request_id)
  const s = p ? d.sessions.get(p.sessionId) : undefined
  if (behavior === 'always' && p && s) s.alwaysAllow.add(p.tool_name)
  if (behavior === 'proj' && p && s) addProjectRule(d, s.projectKey, p.tool_name)
  const ok = resolvePermission(d, request_id, behavior === 'deny' ? 'deny' : 'allow')
  const label = !ok ? tr('⌛ Запрос уже неактуален')
    : behavior === 'always' ? tr('♾ Разрешено; {tool_name} в этой сессии больше не спрашиваю', { tool_name: p!.tool_name })
    : behavior === 'proj' ? tr('📌 Разрешено; {tool_name} в этом проекте больше не спрашиваю (снять — в карточке сессии)', { tool_name: p!.tool_name })
    : behavior === 'allow' ? tr('✅ Разрешено') : tr('❌ Запрещено')
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery?.message
  if (msg && 'text' in msg && msg.text) await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
}

// --- stop button ---

export function stopSession(d: Daemon, s: Session): 'interrupted' | 'noted' {
  s.notes.push('Предыдущий ход был остановлен пользователем кнопкой ⏹ в Telegram') // i18n-ignore: for the model
  d.streams.close(s, 'stopped')
  if (settings.stopMode === 'interrupt' && s.tmuxPane && s.status === 'working') {
    execFile('tmux', ['send-keys', '-t', s.tmuxPane, 'Escape'], err => {
      if (err) d.log(`tmux interrupt for ${s.id} failed: ${err.message}`)
    })
    s.status = 'idle'
    s.turn = null
    d.onSessionsChanged()
    return 'interrupted'
  }
  return 'noted'
}

async function handleStopCallback(d: Daemon, ctx: Context, data: string): Promise<void> {
  const id = data.slice('stop:'.length)
  if (!can(ctx.from!.id, 'stop')) return void ctx.answerCallbackQuery({ text: tr('Нет доступа.') }).catch(() => {})
  const s = d.sessions.get(id)
  if (!s) return void ctx.answerCallbackQuery({ text: tr('Сессия уже отключена.') }).catch(() => {})
  const r = stopSession(d, s)
  await ctx.answerCallbackQuery({
    text: r === 'interrupted' ? tr('⏹ Остановлено') : s.tmuxPane ? tr('Сейчас нечего останавливать.') : tr('Прерывание недоступно: сессия запущена не в tmux.'),
    show_alert: r !== 'interrupted' && !s.tmuxPane,
  }).catch(() => {})
}

// --------------------------------------------------------------------------

export function registerInbound(d: Daemon, bot: Bot, token: string): void {
  d.routeText = (chat, fromId, text, meta) => routeText(d, chat, fromId, text, meta)
  registerReminderCommands(d, bot)
  registerReportCommands(d, bot)
  registerInviteCommands(d, bot)
  registerUserCommands(d, bot)
  registerServerCommands(d, bot)
  registerHubCommands(d, bot)
  registerMacroCommands(d, bot)
  registerGroupHandlers(d, bot)
  // Pairing approvals dropped by the access skill into approved/<senderId>.
  setInterval(() => {
    let files: string[]
    try {
      files = readdirSync(APPROVED_DIR)
    } catch {
      return
    }
    for (const senderId of files) {
      const file = join(APPROVED_DIR, senderId)
      void bot.api.sendMessage(senderId, 'Paired! Say hi to Claude.').finally(() => rmSync(file, { force: true })).catch(() => {})
    }
  }, 5000).unref()

  bot.command('start', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next()
    if (!dmCommandGate(ctx)) return
    await ctx.reply(tr('Этот бот связывает Telegram с сессиями Claude Code.\n\nСопряжение:\n1. Напишите мне что угодно — получите 6-символьный код\n2. В Claude Code: /telegram-bewitched:access pair <code>\n\nДальше: /connect_group — подключить группу с топиками проектов, /help — команды.'))
  })

  bot.command('help', async ctx => {
    if (ctx.chat.type === 'private' && !dmCommandGate(ctx)) return
    if (ctx.chat.type !== 'private' && !can(ctx.from!.id, 'write')) return
    const { text, kb } = helpScreen()
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb, message_thread_id: ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined })
  })

  bot.command('status', async ctx => {
    if (ctx.chat.type !== 'private') return
    const gated = dmCommandGate(ctx)
    if (!gated) return
    const { access, senderId } = gated
    if (access.allowFrom.includes(senderId)) {
      const list = d.activeSessions()
      await ctx.reply([
        tr('Сопряжено как {v}.', { v: ctx.from!.username ? `@${ctx.from!.username}` : senderId }),
        tr('Демон: pid {pid}, опрос {v}, аптайм {v2} мин.', { pid: process.pid, v: d.isPolling() ? tr('идёт') : tr('не идёт'), v2: Math.round(process.uptime() / 60) }),
        tr('Сессий: {length}{v}.', { length: list.length, v: list.length ? ` (${list.map(s => `#${s.id} ${projectTitle(s)}`).join(', ')})` : '' }),
        tr('Группа топиков: {v}.', { v: d.topicsChatId ?? tr('не подключена') }),
      ].join('\n'))
      return
    }
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) return void ctx.reply(tr('Ожидает сопряжения — в Claude Code:\n\n/telegram-bewitched:access pair {code}', { code }))
    }
    await ctx.reply(tr('Не сопряжено. Напишите мне сообщение, чтобы получить код.'))
  })

  // The subscription is the owner's, and the breakdown shows everyone's sessions.
  bot.command('usage', async ctx => {
    if (ctx.chat.type !== 'private' || !can(ctx.from!.id, 'control')) return
    await ctx.reply(await usageReport(d), { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: usageKeyboard(d) })
  })

  bot.command('digest', async ctx => {
    if (ctx.chat.type !== 'private' || !can(ctx.from!.id, 'control')) return
    await ctx.reply(await digestReport(d), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
  })

  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data
    if (data.startsWith('perm:')) return handlePermissionCallback(d, ctx, data)
    if (data.startsWith('q:')) return handleQuestionCallback(d, ctx, data)
    if (data.startsWith('stop:')) return handleStopCallback(d, ctx, data)
    if (await handleLaunchCallback(d, ctx, data)) return
    if (await handleWatchdogCallback(d, ctx, data)) return
    if (await handleScreenCallback(d, ctx, data)) return
    if (await handleResetCallback(d, ctx, data)) return
    if (await handleTokensCallback(d, ctx, data)) return
    if (await handleReminderCallback(d, ctx, data)) return
    if (await handleReportCallback(d, ctx, data)) return
    if (await handleInviteCallback(d, ctx, data)) return
    if (await handleUserCallback(d, ctx, data)) return
    if (await handleServerCallback(d, ctx, data)) return
    if (await handleHubCallback(d, ctx, data)) return
    if (await handleMacroCallback(d, ctx, data)) return
    if (await handleCiCallback(d, ctx, data)) return
    if (await handleGroupCallback(d, ctx, data)) return
    if (await handleSessionMenu(d, ctx, data)) return
    if (await handleTopicMenu(d, ctx, data)) return
    if (await handleTopicCallback(d, ctx, data)) return
    await ctx.answerCallbackQuery().catch(() => {})
  })

  // Native draft stop button (Bot API 10.3): update.stopped_message_generation.
  bot.use(async (ctx, next) => {
    const stopped = (ctx.update as { stopped_message_generation?: { chat: { id: number }; draft_id: number } }).stopped_message_generation
    if (!stopped) return next()
    const chatId = String(stopped.chat.id)
    if (!can(chatId, 'stop')) return
    const s = d.activeSessions().find(x => x.lastChat?.chatId === chatId && x.status === 'working')
    if (s) stopSession(d, s)
  })

  const download = async (fileId: string, uniqueId: string): Promise<string | undefined> => {
    try {
      const file = await bot.api.getFile(fileId)
      if (!file.file_path) return undefined
      const res = await fetch(`${settings.apiRoot ?? 'https://api.telegram.org'}/file/bot${token}/${file.file_path}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = (file.file_path.split('.').pop() ?? 'jpg').replace(/[^a-zA-Z0-9]/g, '') || 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${uniqueId.replace(/[^a-zA-Z0-9_-]/g, '')}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) {
      d.log(`photo download failed: ${err}`)
      return undefined
    }
  }

  bot.on('message:text', ctx => handleInbound(d, ctx, ctx.message.text, undefined))

  bot.on('message:photo', ctx => {
    const best = ctx.message.photo[ctx.message.photo.length - 1]
    return handleInbound(d, ctx, ctx.message.caption ?? '(photo)', () => download(best.file_id, best.file_unique_id))
  })

  bot.on('message:document', ctx => {
    const doc = ctx.message.document
    const name = safeMeta(doc.file_name, 120)
    return handleInbound(d, ctx, ctx.message.caption ?? `(document: ${name ?? 'file'})`, undefined,
      { kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name })
  })

  bot.on('message:voice', ctx => {
    const v = ctx.message.voice
    return handleInbound(d, ctx, ctx.message.caption ?? '(voice message)', undefined,
      { kind: 'voice', file_id: v.file_id, size: v.file_size, mime: v.mime_type, duration: v.duration })
  })

  bot.on('message:audio', ctx => {
    const a = ctx.message.audio
    const name = safeMeta(a.file_name, 120)
    return handleInbound(d, ctx, ctx.message.caption ?? `(audio: ${safeMeta(a.title, 120) ?? name ?? 'audio'})`, undefined,
      { kind: 'audio', file_id: a.file_id, size: a.file_size, mime: a.mime_type, name, duration: a.duration })
  })

  bot.on('message:video', ctx => {
    const v = ctx.message.video
    return handleInbound(d, ctx, ctx.message.caption ?? '(video)', undefined,
      { kind: 'video', file_id: v.file_id, size: v.file_size, mime: v.mime_type, name: safeMeta(v.file_name, 120), duration: v.duration })
  })

  bot.on('message:video_note', ctx => {
    const vn = ctx.message.video_note
    return handleInbound(d, ctx, '(video note)', undefined, { kind: 'video_note', file_id: vn.file_id, size: vn.file_size, duration: vn.duration })
  })

  bot.on('message:sticker', ctx => {
    const st = ctx.message.sticker
    return handleInbound(d, ctx, `(sticker${st.emoji ? ` ${st.emoji}` : ''})`, undefined, { kind: 'sticker', file_id: st.file_id, size: st.file_size })
  })

  bot.on('edited_message:text', ctx => {
    d.store.updateMessageText(String(ctx.chat.id), ctx.editedMessage.message_id, ctx.editedMessage.text)
  })

  // Without this any throw in a handler stops polling (grammY default calls bot.stop()).
  bot.catch(err => d.log(`handler error (polling continues): ${err.error}`))
}

export { sessionTarget }
