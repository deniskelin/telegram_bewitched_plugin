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
import { dmCommandGate, gate, isOwner, loadAccess } from '../access.ts'
import { APPROVED_DIR, INBOX_DIR, settings } from '../config.ts'
import { safeMeta } from '../format.ts'
import { closeByTextReply, handleQuestionCallback } from './buttons.ts'
import type { ChatRef, Daemon, Session } from './daemon.ts'
import { button } from './stream.ts'
import { handleTopicCallback, sessionTarget } from './topics.ts'
import { handleLaunchCallback } from './launch.ts'

// Permission-reply spec from Claude Code: 5 letters a-z minus 'l'.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

type AttachmentMeta = { kind: string; file_id: string; size?: number; mime?: string; name?: string }

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
  | { kind: 'general' }
  | { kind: 'unbound' }
  | { kind: 'archived'; projectKey: string | null; threadId: number }
  | { kind: 'none' }

function resolveTarget(d: Daemon, chatId: string, threadId: number | undefined): Target {
  if (chatId === d.topicsChatId) {
    if (threadId == null) return { kind: 'general' }
    const t = d.store.topic(chatId, threadId)
    if (t?.status === 'archived') return { kind: 'archived', projectKey: t.project_key, threadId }
    const s = d.sessionForThread(chatId, threadId)
    if (s) return { kind: 'session', session: s, projectKey: t?.project_key ?? undefined }
    if (t?.project_key) return { kind: 'offline', projectKey: t.project_key }
    return { kind: 'unbound' }
  }
  const s = d.dmSession()
  return s ? { kind: 'session', session: s } : { kind: 'none' }
}

// --- forward batching: several forwards within 3 s become one event ---

type Batch = { items: { text: string; meta: Record<string, string> }[]; timer: ReturnType<typeof setTimeout>; ctx: Context; chat: ChatRef }
const batches = new Map<string, Batch>()

async function handleInbound(
  d: Daemon,
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
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

  // Permission reply typed as text ("yes abcde").
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    const request_id = permMatch[2]!.toLowerCase()
    const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
    resolvePermission(d, request_id, behavior)
    void d.bot.api.setMessageReaction(chatId, msg.message_id, [{ type: 'emoji', emoji: (behavior === 'allow' ? '✅' : '❌') as ReactionTypeEmoji['emoji'] }]).catch(() => {})
    return
  }

  const target = resolveTarget(d, chatId, threadId)
  const reply = (t: string, kb?: InlineKeyboard) => ctx.reply(t, { message_thread_id: threadId, reply_markup: kb }).catch(() => {})
  if (target.kind === 'general') {
    if (!text.startsWith('/')) await reply('🎛 Это пульт. Пишите в топике проекта или используйте /sessions, /topics, /send, /help.')
    return
  }
  if (target.kind === 'unbound') {
    await reply('Этот топик не привязан к проекту. Сессии создают свои топики сами при запуске.')
    return
  }
  if (target.kind === 'archived') {
    if (target.projectKey) d.store.addPending(target.projectKey, text, { chat_id: chatId, thread_id: String(threadId), user: safeMeta(from.username ?? String(from.id)) ?? '', user_id: String(from.id), ts: new Date(msg.date * 1000).toISOString() })
    await reply('🗄 Топик в архиве. Сообщение сохранил — оно дойдёт до сессии после восстановления.', new InlineKeyboard([[button('▶️ Восстановить', `tp:unar:${target.threadId}`, 'success')]]))
    return
  }
  if (target.kind === 'none') {
    await reply('💤 Нет запущенных сессий Claude Code.')
    return
  }

  if (access.ackReaction) {
    void d.bot.api.setMessageReaction(chatId, msg.message_id, [{ type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] }]).catch(() => {})
  }

  const imagePath = downloadImage ? await downloadImage() : undefined
  const questionId = closeByTextReply(d, chatId, msg.reply_to_message?.message_id)
  const meta: Record<string, string> = {
    chat_id: chatId,
    message_id: String(msg.message_id),
    user: safeMeta(from.username ?? String(from.id)) ?? String(from.id),
    user_id: String(from.id),
    ts: new Date(msg.date * 1000).toISOString(),
    ...(threadId != null ? { thread_id: String(threadId) } : {}),
    ...(threadId != null && d.store.topic(chatId, threadId) ? { topic_name: safeMeta(d.store.topic(chatId, threadId)!.name) ?? '' } : {}),
    ...enrichMeta(d, msg),
    ...(questionId ? { question_id: questionId } : {}),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(attachment ? {
      attachment_kind: attachment.kind,
      attachment_file_id: attachment.file_id,
      ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
      ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
      ...(attachment.name ? { attachment_name: attachment.name } : {}),
    } : {}),
  }

  if (target.kind === 'offline') {
    d.store.addPending(target.projectKey, text, meta)
    await reply('💤 Сессия этого проекта не запущена. Сообщение доставлю, когда она подключится.')
    return
  }

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
  const target = resolveTarget(d, b.chat.chatId, b.chat.threadId)
  if (target.kind !== 'session') return
  if (b.items.length === 1) return d.deliver(target.session, b.items[0].text, b.items[0].meta, b.chat)
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
  s.status = 'waiting'
  d.onSessionsChanged()
  const text = `🔐 ${s.projectName}: ${p.tool_name}`
  const kb = new InlineKeyboard([[
    button('Подробнее', `perm:more:${p.request_id}`),
    button('✅ Разрешить', `perm:allow:${p.request_id}`, 'success'),
    button('❌ Запретить', `perm:deny:${p.request_id}`, 'danger'),
  ]])
  const mode = settings.permissionsTo
  const toTopic = (mode === 'topic' || mode === 'both') && s.topic && d.topicsGroupIsStrict()
  const toDm = mode === 'dm' || mode === 'both' || !toTopic
  if (toTopic) void d.bot.api.sendMessage(s.topic!.chatId, text, { message_thread_id: s.topic!.threadId, reply_markup: kb }).catch(err => d.log(`permission → topic failed: ${err}`))
  if (toDm) for (const chat of loadAccess().allowFrom) void d.bot.api.sendMessage(chat, text, { reply_markup: kb }).catch(err => d.log(`permission → ${chat} failed: ${err}`))
}

async function handlePermissionCallback(d: Daemon, ctx: Context, data: string): Promise<void> {
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
  if (!m) return void ctx.answerCallbackQuery().catch(() => {})
  if (!isOwner(ctx.from!.id)) return void ctx.answerCallbackQuery({ text: 'Нет доступа.' }).catch(() => {})
  const [, behavior, request_id] = m
  if (behavior === 'more') {
    const p = d.permissions.get(request_id)
    if (!p) return void ctx.answerCallbackQuery({ text: 'Подробности уже недоступны.' }).catch(() => {})
    let pretty: string
    try {
      pretty = JSON.stringify(JSON.parse(p.input_preview), null, 2)
    } catch {
      pretty = p.input_preview
    }
    const expanded = `🔐 ${p.tool_name}\n\n${p.description}\n\n${pretty}`.slice(0, 4000)
    const kb = new InlineKeyboard([[button('✅ Разрешить', `perm:allow:${request_id}`, 'success'), button('❌ Запретить', `perm:deny:${request_id}`, 'danger')]])
    await ctx.editMessageText(expanded, { reply_markup: kb }).catch(() => {})
    return void ctx.answerCallbackQuery().catch(() => {})
  }
  const ok = resolvePermission(d, request_id, behavior as 'allow' | 'deny')
  const label = !ok ? '⌛ Запрос уже неактуален' : behavior === 'allow' ? '✅ Разрешено' : '❌ Запрещено'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery?.message
  if (msg && 'text' in msg && msg.text) await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
}

// --- stop button ---

export function stopSession(d: Daemon, s: Session): 'interrupted' | 'noted' {
  s.notes.push('Предыдущий ход был остановлен пользователем кнопкой ⏹ в Telegram')
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
  if (!isOwner(ctx.from!.id)) return void ctx.answerCallbackQuery({ text: 'Нет доступа.' }).catch(() => {})
  const s = d.sessions.get(id)
  if (!s) return void ctx.answerCallbackQuery({ text: 'Сессия уже отключена.' }).catch(() => {})
  const r = stopSession(d, s)
  await ctx.answerCallbackQuery({
    text: r === 'interrupted' ? '⏹ Остановлено' : s.tmuxPane ? 'Сейчас нечего останавливать.' : 'Прерывание недоступно: сессия запущена не в tmux.',
    show_alert: r !== 'interrupted' && !s.tmuxPane,
  }).catch(() => {})
}

// --------------------------------------------------------------------------

export function registerInbound(d: Daemon, bot: Bot, token: string): void {
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
    await ctx.reply('Этот бот связывает Telegram с сессиями Claude Code.\n\nСопряжение:\n1. Напишите мне что угодно — получите 6-символьный код\n2. В Claude Code: /telegram-bewitched:access pair <code>\n\nДальше: /connect_group — подключить группу с топиками проектов, /help — команды.')
  })

  bot.command('help', async ctx => {
    if (ctx.chat.type === 'private' && !dmCommandGate(ctx)) return
    if (ctx.chat.type !== 'private' && !isOwner(ctx.from!.id)) return
    await ctx.reply([
      'Пульт (личка или General группы):',
      '/sessions — запущенные сессии',
      '/topics — все топики',
      '/send <топик> <текст> — написать в сессию другого топика',
      '/broadcast <текст> — во все сессии',
      '/rename <топик> | <имя>, /archive <топик>, /delete <топик>',
      '/use <id> — какая сессия получает личку',
      '/new_session <имя|путь> — новый проект и сессия в tmux',
      'Новый топик в группе → проект в PROJECTS_DIR и сессия в tmux',
      '',
      'В любом чате/топике:',
      '/verbose 0|1|2 — подробность прогресса',
      '/notify_done off|long|always — уведомления о завершении',
      '/remember — сохранить память чата, /forget — стереть историю',
      '',
      'Только в личке: /connect_group, /group, /disconnect_group, /status',
    ].join('\n'), { message_thread_id: ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined })
  })

  bot.command('status', async ctx => {
    if (ctx.chat.type !== 'private') return
    const gated = dmCommandGate(ctx)
    if (!gated) return
    const { access, senderId } = gated
    if (access.allowFrom.includes(senderId)) {
      const list = d.activeSessions()
      await ctx.reply([
        `Сопряжено как ${ctx.from!.username ? `@${ctx.from!.username}` : senderId}.`,
        `Демон: pid ${process.pid}, опрос ${d.isPolling() ? 'идёт' : 'не идёт'}, аптайм ${Math.round(process.uptime() / 60)} мин.`,
        `Сессий: ${list.length}${list.length ? ` (${list.map(s => `#${s.id} ${s.projectName}`).join(', ')})` : ''}.`,
        `Группа топиков: ${d.topicsChatId ?? 'не подключена'}.`,
      ].join('\n'))
      return
    }
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) return void ctx.reply(`Ожидает сопряжения — в Claude Code:\n\n/telegram-bewitched:access pair ${code}`)
    }
    await ctx.reply('Не сопряжено. Напишите мне сообщение, чтобы получить код.')
  })

  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data
    if (data.startsWith('perm:')) return handlePermissionCallback(d, ctx, data)
    if (data.startsWith('q:')) return handleQuestionCallback(d, ctx, data)
    if (data.startsWith('stop:')) return handleStopCallback(d, ctx, data)
    if (await handleLaunchCallback(d, ctx, data)) return
    if (await handleTopicCallback(d, ctx, data)) return
    await ctx.answerCallbackQuery().catch(() => {})
  })

  // Native draft stop button (Bot API 10.3): update.stopped_message_generation.
  bot.use(async (ctx, next) => {
    const stopped = (ctx.update as { stopped_message_generation?: { chat: { id: number }; draft_id: number } }).stopped_message_generation
    if (!stopped) return next()
    const chatId = String(stopped.chat.id)
    if (!isOwner(chatId)) return
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
      { kind: 'voice', file_id: v.file_id, size: v.file_size, mime: v.mime_type })
  })

  bot.on('message:audio', ctx => {
    const a = ctx.message.audio
    const name = safeMeta(a.file_name, 120)
    return handleInbound(d, ctx, ctx.message.caption ?? `(audio: ${safeMeta(a.title, 120) ?? name ?? 'audio'})`, undefined,
      { kind: 'audio', file_id: a.file_id, size: a.file_size, mime: a.mime_type, name })
  })

  bot.on('message:video', ctx => {
    const v = ctx.message.video
    return handleInbound(d, ctx, ctx.message.caption ?? '(video)', undefined,
      { kind: 'video', file_id: v.file_id, size: v.file_size, mime: v.mime_type, name: safeMeta(v.file_name, 120) })
  })

  bot.on('message:video_note', ctx => {
    const vn = ctx.message.video_note
    return handleInbound(d, ctx, '(video note)', undefined, { kind: 'video_note', file_id: vn.file_id, size: vn.file_size })
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
