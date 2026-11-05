import { bindTask } from './taskcost.ts'
/**
 * Inbound Telegram traffic: access gate, routing to the right session,
 * reply/quote/forward enrichment, forward batching, permission relay and the
 * callback-button dispatcher.
 */

import { registerTaskCommands, handleTaskCallback, applyTask, selectedTask, prepareFile, acknowledgeFile } from './tasks.ts'
import { verifyStop } from './stopcheck.ts'
import { receiveMessage, deliveryPhase, sessionPhase, handleUxCallback, replacementSession } from './ux.ts'
import { projectEngine, setProjectEngine, setProjectEffort, engineOf } from './engines.ts'
import { queueTextBatch, economyReport, cancelTextBatch, taskBatchMeta } from './economy.ts'
import { InlineKeyboard, type Bot, type Context } from 'grammy'
import type { Message, ReactionTypeEmoji } from 'grammy/types'
import { readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { can, dmCommandGate, gate, loadAccess, owner, prefsFor, roleOf } from '../access.ts'
import { APPROVED_DIR, settings } from '../config.ts'
import { clip, safeMeta } from '../format.ts'
import { richToMarkdown } from '../rich.ts'
import { toWav16k } from '../voice/audio.ts'
import { sttEnabled, transcribe, type SttResult } from '../voice/stt.ts'
import { downloadToInbox } from './media.ts'
import { closeByTextReply, handleQuestionCallback } from './buttons.ts'
import { userPendingKey, type ChatRef, type Daemon, type Session } from './daemon.ts'
import { button } from './stream.ts'
import { handleDashboardCallback, handleTopicCallback, sessionTarget } from './topics.ts'
import { handleLaunchCallback, launchForTopic, launchUserSession } from './launch.ts'
import { idleRecord } from './autoresume.ts'
import { handleWatchdogCallback } from './watchdog.ts'
import { handleCodexApprovalCallback } from './codexapproval.ts'
import { journal, journalText, who } from './journal.ts'
import { handleIdleCallback } from './idle.ts'
import { handleShortcutCallback, withoutModel } from './shortcuts.ts'
import { handleVoiceForbiddenCallback } from './tools.ts'
import { handleTokensCallback } from './outoftokens.ts'
import { handleResetCallback, usageKeyboard, usageReport } from './usage.ts'
import { sendDaily, todaySoFar } from './daily.ts'
import { handleSessionMenu, sessionCommandScreen } from './menu.ts'
import { handleScreenCallback } from './screen.ts'
import { handleReminderCallback, registerReminderCommands } from './reminders.ts'
import { handleOrphanCallback } from './orphans.ts'
import { handleReportCallback, registerReportCommands } from './reports.ts'
import { handleInviteCallback, registerInviteCommands } from './invite.ts'
import { handleUserCallback, registerUserCommands } from './users.ts'
import { handleTopicMenu } from './topicmenu.ts'
import { handleCiCallback } from './events.ts'
import { askOwnerAboutGroup, groupBinding, groupPendingKey, handleGroupCallback, isProjectGroup, launchForGroup, registerGroupHandlers } from './groups.ts'
import { handleMacroCallback, registerMacroCommands } from './macros.ts'
import { addProjectRule, projectRules } from './permrules.ts'
import { handleServerCallback, registerServerCommands } from './server.ts'
import { handleCliCallback } from './cliupdate.ts'
import { handleReplyConvCallback, holdIfOldConversation } from './replyconv.ts'
import { handlePromptCallback, registerPromptCommands } from './promptmode.ts'
import { handleReviewCallback, registerOnceCommands } from './oneshot.ts'
import { handleHubCallback, helpScreen, registerHubCommands } from './hub.ts'
import { t as tr } from '../i18n/index.ts'
import { projectTitle } from './report.ts'

// Permission-reply spec from Claude Code: 5 letters a-z minus 'l'.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
/** /clear, /compact, /model, /cost (optionally @bot): Claude Code commands, handled by the daemon. */
const SESSION_COMMAND_RE = /^\/(clear|compact|model|cost)(?:@\w+)?(?:\s+\S+)?\s*$/i

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
  | { kind: 'session'; session: Session; projectKey?: string }
  | { kind: 'offline'; projectKey: string }
  | { kind: 'launch'; projectKey: string; threadId: number }
  | { kind: 'waiting'; projectKey: string }
  | { kind: 'user_offline'; userId: string }
  | { kind: 'unbound' }
  | { kind: 'archived'; projectKey: string | null; threadId: number }
  /** An ordinary group the owner hasn't decided about yet (groups.ts). */
  | { kind: 'group_unbound'; chatId: string }
  /** An ordinary group's project without a running session. */
  | { kind: 'group_launch'; chatId: string; projectKey: string }

export function resolveTarget(d: Daemon, chat: ChatRef, fromId: string): Target {
  const { chatId, threadId } = chat
  if (d.isTopicsChat(chatId) && threadId != null) {
    const t = d.store.topic(chatId, threadId)
    if (t?.status === 'archived') return { kind: 'archived', projectKey: t.project_key, threadId }
    const s = d.sessionForThread(chatId, threadId)
    if (s) return { kind: 'session', session: s, projectKey: t?.project_key ?? undefined }
    if (t?.project_key) {
      // Suspended for idling: it wakes up on the message, whatever TOPIC_NO_SESSION says.
      if (idleRecord(d, t.project_key)) return { kind: 'launch', projectKey: t.project_key, threadId }
      if (t.status === 'waiting') return { kind: 'waiting', projectKey: t.project_key }
      if (settings.topicNoSession === 'launch') return { kind: 'launch', projectKey: t.project_key, threadId }
      return { kind: 'offline', projectKey: t.project_key }
    }
    // A topic without a project: the author's own session.
    return userTarget(d, fromId)
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
  // DMs, General and a group that is not a project: the author's own session.
  if (chat.isPrivate || d.isTopicsChat(chatId) || isProjectGroup(d, chatId)) return userTarget(d, fromId)
  return { kind: 'unbound' }
}

/**
 * Text that did not come from a Telegram message (a reminder): same routing
 * as a message — the serving session, else queue and start it if we can.
 */
export async function routeText(d: Daemon, chat: ChatRef, fromId: string, text: string, meta: Record<string, string>): Promise<void> {
  if (meta.user_id || fromId) bindTask(d, chat, meta.user_id ?? fromId, meta)
  const target = resolveTarget(d, chat, fromId)
  switch (target.kind) {
    case 'session':
      return d.deliver(target.session, text, meta, chat)
    case 'launch':
      d.store.addPending(target.projectKey, text, meta)
      return launchForTopic(d, chat.chatId, target.threadId, target.projectKey, d.userLabel(fromId))
    case 'user_offline':
      d.store.addPending(userPendingKey(target.userId), text, meta)
      return launchUserSession(d, target.userId, d.userLabel(target.userId), { chatId: chat.chatId, threadId: chat.threadId })
    case 'offline':
    case 'waiting':
      d.store.addPending(target.projectKey, text, meta)
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

/** The folder of the session a message is for: its files are saved there, readable without a prompt (media.ts). */
function targetDir(d: Daemon, t: Target): string | undefined {
  switch (t.kind) {
    case 'session': return t.session.cwd
    case 'launch': case 'offline': case 'waiting': case 'group_launch': return t.projectKey
    case 'archived': return t.projectKey ?? undefined
    case 'user_offline': return join(settings.usersDir, t.userId)
    default: return undefined
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

/**
 * Custom emoji of a message as Markdown the model can read and reuse in a rich
 * answer: ![🤖](tg://emoji?id=5368324170671202286). Telegram sends only the
 * fallback character in the text; the id is in the entities (offsets in UTF-16
 * code units, as JS strings are).
 */
export function withCustomEmoji(text: string, entities: readonly { type: string; offset: number; length: number; custom_emoji_id?: string }[] | undefined): string {
  const list = (entities ?? []).filter(e => e.type === 'custom_emoji' && e.custom_emoji_id && /^\d+$/.test(e.custom_emoji_id)).sort((a, b) => b.offset - a.offset)
  let out = text
  for (const e of list) {
    const ch = out.slice(e.offset, e.offset + e.length)
    if (!ch) continue
    out = `${out.slice(0, e.offset)}![${ch}](tg://emoji?id=${e.custom_emoji_id})${out.slice(e.offset + e.length)}`
  }
  return out
}

async function handleInbound(
  d: Daemon,
  ctx: Context,
  original: string,
  downloadImage: ((dir: string | undefined) => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  let text = original
  const result = gate(ctx, d.botUsername)
  // Someone who is not a user wrote in a DM (dropped, or asked to pair): the journal hears of it.
  if ((result.action === 'drop' || result.action === 'pair') && ctx.chat?.type === 'private' && ctx.from) {
    const from = who(ctx.from)
    const pair = result.action === 'pair'
    void journal(d, 'access', () => journalText.stranger(from, pair ? tr(' · просит сопряжение') : '', original || (attachment ? `[${attachment.kind}]` : '')))
  }
  if (result.action === 'drop') return
  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram-bewitched:access pair ${result.code}`)
    return
  }

  const access = result.access
  const msg = ctx.message!
  const from = ctx.from!
  // The custom emoji's ids are only in the entities: kept in the text, for the model and the history.
  if (text === (msg.text ?? msg.caption)) text = withCustomEmoji(text, msg.entities ?? msg.caption_entities)
  const chatId = String(ctx.chat!.id)
  const threadId = msg.is_topic_message ? msg.message_thread_id : undefined
  const isPrivate = ctx.chat!.type === 'private'
  const chat: ChatRef = { chatId, threadId, isPrivate }

  receiveMessage(d, chat, String(msg.message_id), String(from.id))
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
    deliveryPhase(d, { chat_id: chatId, message_id: String(msg.message_id) }, 'done')
    const request_id = permMatch[2]!.toLowerCase()
    const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
    resolvePermission(d, request_id, behavior)
    void d.bot.api.setMessageReaction(chatId, msg.message_id, [{ type: 'emoji', emoji: (behavior === 'allow' ? '✅' : '❌') as ReactionTypeEmoji['emoji'] }]).catch(() => {})
    return
  }

  const target = resolveTarget(d, chat, String(from.id))
  const reply = (t: string, kb?: InlineKeyboard) => ctx.reply(t, { message_thread_id: threadId, reply_markup: kb }).catch(() => {})
  // Claude Code's own commands are for the session's window, not for the model: answer here, no turn spent.
  const sc = SESSION_COMMAND_RE.exec(text)
  if (sc && !attachment) {
    deliveryPhase(d, { chat_id: chatId, message_id: String(msg.message_id) }, 'done')
    const s = target.kind === 'session' ? target.session : null
    if (!can(from.id, 'control')) await reply(tr('Команды окна сессии — у владельца.'))
    else if (!s) await reply(tr('Сессия здесь не запущена — команду некуда отправить.'))
    else {
      const screen = await sessionCommandScreen(d, s, sc[1]!.toLowerCase() as 'clear' | 'compact' | 'model' | 'cost')
      await ctx.reply(screen.text, { parse_mode: 'HTML', message_thread_id: threadId, reply_markup: screen.kb }).catch(err => d.log(`session command failed: ${err}`))
    }
    return
  }
  // Unknown commands in General are not for Claude.
  if (d.isTopicsChat(chatId) && threadId == null && text.startsWith('/')) { deliveryPhase(d, { chat_id: chatId, message_id: String(msg.message_id) }, 'done'); return }
  if (target.kind === 'unbound') {
    deliveryPhase(d, { chat_id: chatId, message_id: String(msg.message_id) }, 'failed')
    await reply(tr('Этот чат не привязан ни к проекту, ни к пользователю — сообщение некуда доставить.'))
    return
  }
  if (target.kind === 'archived') {
    deliveryPhase(d, { chat_id: chatId, message_id: String(msg.message_id) }, 'queued')
    if (target.projectKey) d.store.addPending(target.projectKey, text, { chat_id: chatId, thread_id: String(threadId), user: safeMeta(from.username ?? String(from.id)) ?? '', user_id: String(from.id), ts: new Date(msg.date * 1000).toISOString() })
    await reply(tr('🗄 Топик в архиве. Сообщение сохранил — оно дойдёт до сессии после восстановления.'), new InlineKeyboard([[button(tr('▶️ Восстановить'), `tp:unar:${target.threadId}`, 'success')]]))
    return
  }
  if (access.ackReaction) {
    void d.bot.api.setMessageReaction(chatId, msg.message_id, [{ type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] }]).catch(() => {})
  }

  const imagePath = downloadImage ? await downloadImage(targetDir(d, target)) : undefined
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

  const hasFile = !!downloadImage || !!attachment && !isSpeech(attachment.kind)
  const continuingTask = target.kind === 'session' && target.session.status === 'working' && !!target.session.turn
  if (hasFile && !msg.caption?.trim() && !selectedTask(d, chat, String(from.id)) && !continuingTask) {
    await prepareFile(d, ctx, chat, String(from.id), text, meta)
    return
  }
  if (target.kind !== 'session') text = applyTask(d, chat, String(from.id), text, meta)
  if (hasFile) await acknowledgeFile(d, ctx, chat, String(from.id), meta.task_kind ?? selectedTask(d, chat, String(from.id)) ?? undefined)

  if (target.kind !== 'session') deliveryPhase(d, meta, target.kind === 'launch' || target.kind === 'user_offline' || target.kind === 'group_launch' ? 'launching' : 'queued')

  if (target.kind === 'group_unbound') {
    deliveryPhase(d, meta, 'queued')
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
  if (target.kind === 'user_offline') {
    d.store.addPending(userPendingKey(target.userId), text, meta)
    void launchUserSession(d, target.userId, d.userLabel(target.userId), { chatId, threadId }).catch(err => d.log(`user launch failed: ${err}`))
    return
  }
  if (target.kind === 'launch') {
    d.store.addPending(target.projectKey, text, meta)
    void launchForTopic(d, chatId, target.threadId, target.projectKey, d.userLabel(String(from.id))).catch(err => d.log(`topic launch failed: ${err}`))
    return
  }
  if (target.kind === 'waiting') {
    d.store.addPending(target.projectKey, text, meta)
    // 🚀 only for whoever may press it: a member would get «Нет доступа».
    const run = ctx.from && can(ctx.from.id, 'control') ? new InlineKeyboard([[button(tr('🚀 Запустить'), `wd:topic:${threadId}`, 'success')]]) : undefined
    await reply(tr('⏳ Сессия проекта не подключена — сообщение в очереди.'), run)
    return
  }
  // FR-9: what the daemon can answer itself never wakes the session.
  if (!msg.forward_origin && !imagePath && !(attachment && !isSpeech(attachment.kind))) {
    const handled = await withoutModel(d, ctx, text, target.session, { chatId, threadId, messageId: msg.message_id, from: from.id }, (s2, t2) => d.deliver(s2, t2, meta, chat))
    if (handled) { deliveryPhase(d, meta, 'done', target.session); return }
  }

  text = applyTask(d, chat, String(from.id), text, meta)

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

  // FR-20: a reply to a message of an older conversation asks where it goes.
  if (await holdIfOldConversation(d, target.session, chat, text, meta).catch(err => { d.log(`reply conversation check failed: ${err}`); return false })) return
  if (!imagePath && !attachment && !msg.reply_to_message && !questionId && !text.startsWith('/') && queueTextBatch(d, chat, String(from.id), text, meta)) { deliveryPhase(d, meta, 'queued', target.session); return }
  d.deliver(target.session, text, meta, chat)
}

function flushBatch(d: Daemon, key: string): void {
  const b = batches.get(key)
  if (!b) return
  batches.delete(key)
  const last = b.items.at(-1)!.meta
  // Re-resolve at dispatch: a session may have restarted while forwards were being collected.
  const content = b.items.length === 1 ? b.items[0]!.text :
    `Переслано сообщений: ${b.items.length}\n\n` + b.items.map((it, i) => // i18n-ignore
      `${i + 1}. [${it.meta.forward_from ?? '?'}${it.meta.forward_date ? `, ${it.meta.forward_date}` : ''}] ${it.text}`).join('\n\n')
  const meta = { ...last, ...taskBatchMeta(b.items.map(x => x.meta)), message_ids: b.items.map(x => x.meta.message_id).join(','), ...(b.items.length > 1 ? { forward_count: String(b.items.length) } : {}) }
  void routeText(d, b.chat, String(b.ctx.from?.id ?? ''), content, meta).catch(err => { deliveryPhase(d, meta, 'failed'); d.log(`forward batch: ${err}`) })
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

export type StopSource = 'button' | 'menu' | 'shortcut' | 'stopped_message_generation'

export function stopSession(d: Daemon, s: Session, source: StopSource): 'interrupted' | 'noted' {
  for (const key of d.store.keys('economy:batch:')) {
    const batch = JSON.parse(d.store.get(key)!) as { chat: ChatRef; from: string }
    const target = resolveTarget(d, batch.chat, batch.from)
    if (target.kind === 'session' && target.session === s) cancelTextBatch(d, batch.chat, batch.from)
  }
  s.notes.push('Предыдущий ход был остановлен пользователем кнопкой ⏹ в Telegram') // i18n-ignore: for the model
  d.streams.close(s, 'stopped')
  if (settings.stopMode === 'interrupt' && s.tmuxPane && (s.status === 'working' || s.status === 'waiting')) {
    // Through the daemon's tmux adapter (tests replace it): never a tmux call of its own.
    if (s.stopRequest?.phase === 'sent') return 'interrupted'
    const at = Date.now()
    s.stoppedAt = at
    s.stopRequest = { at, phase: 'sent' }
    void d.tmuxKeys(s.tmuxPane, ['Escape']).then(() => {
      setTimeout(() => void verifyStop(d, s, at).catch(err => d.log(`stop verification: ${err}`)), 700).unref?.()
    }).catch(err => {
      s.stopRequest = { at, phase: 'failed' }
      d.log(`tmux interrupt for ${s.id} failed: ${err}`)
      const c = s.lastChat
      if (c) void d.bot.api.sendMessage(c.chatId, tr('Остановка не подтверждена'), { message_thread_id: c.threadId }).catch(() => {})
    })
    d.log(`stop #${s.id} via ${source}: Escape sent to ${s.tmuxPane}`)
    d.onSessionsChanged()
    return 'interrupted'
  }
  const why = settings.stopMode !== 'interrupt' ? `STOP_MODE=${settings.stopMode}` : !s.tmuxPane ? 'not in tmux' : `status ${s.status}`
  d.log(`stop #${s.id} via ${source}: no Escape (${why}), noted for the next message`)
  return 'noted'
}

async function handleStopCallback(d: Daemon, ctx: Context, data: string): Promise<void> {
  const id = data.slice('stop:'.length)
  if (!can(ctx.from!.id, 'stop')) return void ctx.answerCallbackQuery({ text: tr('Нет доступа.') }).catch(() => {})
  const s = d.sessions.get(id)
  if (!s) {
    const current = replacementSession(d, id)
    await ctx.answerCallbackQuery({ text: current ? tr('Сессия перезапущена: откройте актуальную карточку.') : tr('Сессия уже отключена.') }).catch(() => {})
    if (current && can(ctx.from!.id, 'control')) await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard([[button(tr('Открыть текущую сессию'), `sm:s:${current.id}`)]]) }).catch(() => {})
    return
  }
  if (ctx.chat) cancelTextBatch(d, { chatId: String(ctx.chat.id), threadId: ctx.callbackQuery?.message?.message_thread_id, isPrivate: ctx.chat.type === 'private' }, String(ctx.from!.id))
  const r = stopSession(d, s, 'button')
  await ctx.answerCallbackQuery({
    text: r === 'interrupted' ? tr('Команда остановки отправлена') : s.tmuxPane ? tr('Сейчас нечего останавливать.') : tr('Прерывание недоступно: сессия запущена не в tmux.'),
    show_alert: r !== 'interrupted' && !s.tmuxPane,
  }).catch(() => {})
}

// --------------------------------------------------------------------------

export function registerInbound(d: Daemon, bot: Bot, token: string): void {
  d.routeText = (chat, fromId, text, meta) => routeText(d, chat, fromId, text, meta)
  bot.command('economy', async ctx => {
    if (!ctx.from || !can(ctx.from.id, 'control')) return
    const extra = { message_thread_id: ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined }
    const respond = (text: string) => ctx.reply(text, extra)
    const arg = String(ctx.match ?? '').trim()
    if (arg) {
      const chatId = String(ctx.chat.id)
      const threadId = ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined
      const target = resolveTarget(d, { chatId, threadId, isPrivate: ctx.chat.type === 'private' }, String(ctx.from.id))
      if (target.kind !== 'session') { await respond('Connect a session first.'); return }
      const [preset, model] = arg.split(/\s+/)
      const choice = projectEngine(d, target.session.projectKey)
      const engine = engineOf(choice.engine)
      const effort = ({ fast: 'low', balanced: 'medium', thorough: 'high' } as Record<string, string>)[preset!]
      const selected = model ? engine.models.find(m => m.id === model || m.alias === model) : undefined
      if (!effort || arg.split(/\s+/).length > 2 || model && !selected) { await respond('Usage: /economy [fast|balanced|thorough] [model alias]. Applies at next session launch.'); return }
      setProjectEffort(d, target.session.projectKey, choice.engine, effort)
      if (selected) setProjectEngine(d, target.session.projectKey, { ...choice, model: selected.id })
      await respond(`Next launch: ${engine.name}; model=${selected?.id ?? choice.model ?? 'CLI default'}; effort=${effort}.`)
      return
    }
    await respond(economyReport(d))
  })
  registerTaskCommands(d, bot)
  registerReminderCommands(d, bot)
  registerPromptCommands(d, bot)
  registerOnceCommands(d, bot)
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
    if (!await sendDaily(d, String(ctx.chat.id), todaySoFar())) await ctx.reply(tr('Не получилось отправить итоги — подробности в журнале демона.')).catch(() => {})
  })

  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data
    if (await handleTaskCallback(d, ctx, data)) return
    if (await handleUxCallback(d, ctx, data)) return
    if (data.startsWith('perm:')) return handlePermissionCallback(d, ctx, data)
    if (data.startsWith('q:')) return handleQuestionCallback(d, ctx, data)
    if (data.startsWith('stop:')) return handleStopCallback(d, ctx, data)
    if (await handleLaunchCallback(d, ctx, data)) return
    if (await handleIdleCallback(d, ctx, data)) return
    if (await handleShortcutCallback(d, ctx, data)) return
    if (await handleVoiceForbiddenCallback(d, ctx, data)) return
    if (await handleWatchdogCallback(d, ctx, data)) return
    if (await handleCodexApprovalCallback(d, ctx, data)) return
    if (await handleScreenCallback(d, ctx, data)) return
    if (await handleResetCallback(d, ctx, data)) return
    if (await handleTokensCallback(d, ctx, data)) return
    if (await handleReminderCallback(d, ctx, data)) return
    if (await handleOrphanCallback(d, ctx, data)) return
    if (await handleDashboardCallback(d, ctx, data)) return
    if (await handleReportCallback(d, ctx, data)) return
    if (await handleInviteCallback(d, ctx, data)) return
    if (await handleUserCallback(d, ctx, data)) return
    if (await handleServerCallback(d, ctx, data)) return
    if (await handleCliCallback(d, ctx, data)) return
    if (await handleReplyConvCallback(d, ctx, data)) return
    if (await handlePromptCallback(d, ctx, data)) return
    if (await handleReviewCallback(d, ctx, data)) return
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
    const stopped = (ctx.update as { stopped_message_generation?: { chat: { id: number }; draft_id: number; message_thread_id?: number } }).stopped_message_generation
    if (!stopped) return next()
    const chatId = String(stopped.chat.id)
    if (!can(chatId, 'stop')) return
    // The draft names its session; else the thread, if the update has one; else the chat, when only one session works there.
    const byDraft = d.streams.sessionByDraft(chatId, stopped.draft_id)
    const working = d.activeSessions().filter(x => x.lastChat?.chatId === chatId && x.status === 'working')
    const inThread = stopped.message_thread_id != null ? working.filter(x => x.lastChat?.threadId === stopped.message_thread_id) : working
    const s = byDraft ? d.sessions.get(byDraft) : inThread.length === 1 ? inThread[0] : undefined
    if (s) stopSession(d, s, 'stopped_message_generation')
    else d.log(`stopped_message_generation in ${chatId}: draft ${stopped.draft_id} matches no single session (${inThread.length} working)`)
  })

  const download = async (fileId: string, dir: string | undefined): Promise<string | undefined> => {
    try {
      return await downloadToInbox(d, fileId, dir)
    } catch (err) {
      d.log(`photo download failed: ${err}`)
      return undefined
    }
  }

  bot.on('message:text', ctx => handleInbound(d, ctx, ctx.message.text, undefined))

  bot.on('message:photo', ctx => {
    const best = ctx.message.photo[ctx.message.photo.length - 1]
    return handleInbound(d, ctx, ctx.message.caption ?? '(photo)', dir => download(best.file_id, dir))
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

  // FR-11: a rich message (forwarded from a bot, Bot API 10.1+) has no text — its blocks go to the session as Markdown.
  bot.on('message', (ctx, next) => {
    const rm = (ctx.message as { rich_message?: unknown }).rich_message
    if (!rm) return next()
    return handleInbound(d, ctx, richToMarkdown(rm) || '(rich message)', undefined)
  })

  bot.on('edited_message:text', ctx => {
    d.store.updateMessageText(String(ctx.chat.id), ctx.editedMessage.message_id, ctx.editedMessage.text)
  })

  // Without this any throw in a handler stops polling (grammY default calls bot.stop()).
  bot.catch(err => d.log(`handler error (polling continues): ${err.error}`))
}

export { sessionTarget }
