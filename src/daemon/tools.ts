/**
 * MCP tool calls proxied from a session's client. Executed here so all
 * outbound traffic shares one Bot instance (rate limits, history, streams).
 */

import { InputFile, InlineKeyboard } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { mkdirSync, statSync, writeFileSync } from 'fs'
import { extname, join } from 'path'
import { assertAllowedChat, assertSendable, loadAccess, owner } from '../access.ts'
import { INBOX_DIR, MEMORY_DIR, settings } from '../config.ts'
import { chunk } from '../format.ts'
import { isThreadNotFound, sendRich, topicLink } from '../tg.ts'
import { parseOptions, postQuestion } from './buttons.ts'
import type { ChatRef, Daemon, Session } from './daemon.ts'
import { addReminder, fmtWhen, parseWhen } from './reminders.ts'
import { button } from './stream.ts'
import { archiveTopic, ensureTopic, memoryPath, readMemory, renameTopic, sessionTarget } from './topics.ts'

const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function str(v: unknown): string | undefined {
  return v == null || v === '' ? undefined : String(v)
}

function int(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

/**
 * Resolve where a tool call should go. Explicit chat_id wins; the thread
 * defaults to the session's topic or the thread of the last inbound message
 * from that chat.
 */
function resolveChat(d: Daemon, s: Session, args: Record<string, unknown>): ChatRef {
  const explicit = str(args.chat_id)
  const thread = int(args.message_thread_id ?? args.thread_id)
  const def = sessionTarget(d, s)
  const chatId = explicit ?? def?.chatId
  if (!chatId) throw new Error('chat_id is required (no default chat for this session yet)')
  let threadId = thread
  if (threadId == null) {
    if (s.lastChat?.chatId === chatId) threadId = s.lastChat.threadId
    else if (s.topic?.chatId === chatId) threadId = s.topic.threadId
  }
  return { chatId, threadId, isPrivate: !chatId.startsWith('-') }
}

function threadOpt(c: ChatRef): { message_thread_id?: number } {
  return c.threadId != null ? { message_thread_id: c.threadId } : {}
}

function checkFiles(files: string[]): void {
  for (const f of files) {
    assertSendable(f)
    const st = statSync(f)
    if (st.size > MAX_ATTACHMENT_BYTES) throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
  }
}

function recordOut(d: Daemon, c: ChatRef, messageId: number, text: string, kind = 'text'): void {
  d.store.addMessage({
    chat_id: c.chatId, thread_id: c.threadId ?? null, message_id: messageId, direction: 'out', from_id: String(d.botId),
    from_name: 'bot', date: Math.floor(Date.now() / 1000), text, kind, file_id: null, reply_to: null, quote: null, forward: null,
  })
}

/** Run a send against a topic; if the topic was deleted under us, recreate it and retry once. */
async function withTopicRetry<T>(d: Daemon, s: Session, c: ChatRef, fn: (c: ChatRef) => Promise<T>): Promise<T> {
  try {
    return await fn(c)
  } catch (err) {
    if (s.topic && c.chatId === s.topic.chatId && c.threadId === s.topic.threadId && isThreadNotFound(err)) {
      d.store.deleteTopic(s.topic.chatId, s.topic.threadId)
      s.topic = null
      const t = await ensureTopic(d, s)
      if (t) return await fn({ ...c, threadId: t.threadId })
    }
    throw err
  }
}

async function sendFiles(d: Daemon, c: ChatRef, files: string[], replyTo?: number): Promise<number[]> {
  const ids: number[] = []
  for (const f of files) {
    const opts = { ...threadOpt(c), ...(replyTo != null ? { reply_parameters: { message_id: replyTo } } : {}) }
    const sent = PHOTO_EXTS.has(extname(f).toLowerCase())
      ? await d.bot.api.sendPhoto(c.chatId, new InputFile(f), opts)
      : await d.bot.api.sendDocument(c.chatId, new InputFile(f), opts)
    ids.push(sent.message_id)
    recordOut(d, c, sent.message_id, `(file: ${f.split('/').pop()})`, 'document')
  }
  return ids
}

function idsResult(ids: number[]): string {
  return ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(', ')})`
}

async function reply(d: Daemon, s: Session, args: Record<string, unknown>): Promise<string> {
  const c = resolveChat(d, s, args)
  assertAllowedChat(c.chatId)
  const text = String(args.text ?? '')
  const replyTo = int(args.reply_to)
  const files = (args.files as string[] | undefined) ?? []
  const format = str(args.format) ?? 'text'
  checkFiles(files)

  if (args.buttons != null) {
    const opts = parseOptions(args.buttons)
    const q = await withTopicRetry(d, s, c, cc => postQuestion(d, s, cc, text, opts, { replyTo }))
    recordOut(d, c, q.messageId, text)
    const ids = [q.messageId, ...(await sendFiles(d, c, files, replyTo))]
    finishReply(d, s, c)
    return `${idsResult(ids)}; question_id: ${q.id}`
  }

  const access = loadAccess()
  const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  const replyMode = access.replyToMode ?? 'first'
  const ids: number[] = []

  await withTopicRetry(d, s, c, async cc => {
    c.threadId = cc.threadId
    if (format === 'rich') {
      try {
        const id = await sendRich(d.bot, cc.chatId, text, {
          ...threadOpt(cc), ...(replyTo != null && replyMode !== 'off' ? { reply_parameters: { message_id: replyTo } } : {}),
        })
        ids.push(id)
        recordOut(d, cc, id, text)
        return
      } catch (err) {
        if (isThreadNotFound(err)) throw err
        d.log(`sendRichMessage failed, falling back to text: ${err}`)
      }
    }
    const parseMode = format === 'markdownv2' ? ('MarkdownV2' as const) : undefined
    const parts = chunk(text, limit, access.chunkMode ?? 'length')
    for (let i = 0; i < parts.length; i++) {
      const shouldReplyTo = replyTo != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
      try {
        const sent = await d.bot.api.sendMessage(cc.chatId, parts[i], {
          ...threadOpt(cc),
          ...(shouldReplyTo ? { reply_parameters: { message_id: replyTo! } } : {}),
          ...(parseMode ? { parse_mode: parseMode } : {}),
        })
        ids.push(sent.message_id)
        recordOut(d, cc, sent.message_id, parts[i])
      } catch (err) {
        if (i === 0) throw err
        throw new Error(`reply failed after ${ids.length} of ${parts.length} chunk(s) sent: ${err instanceof Error ? err.message : err}`)
      }
    }
  })
  ids.push(...(await sendFiles(d, c, files, replyMode !== 'off' ? replyTo : undefined)))
  finishReply(d, s, c)
  return idsResult(ids)
}

function finishReply(d: Daemon, s: Session, c: ChatRef): void {
  if (s.turn) s.turn.replied = true
  d.streams.onReply(s, c.chatId)
}

async function askUser(d: Daemon, s: Session, args: Record<string, unknown>): Promise<string> {
  const c = resolveChat(d, s, args)
  assertAllowedChat(c.chatId)
  const opts = parseOptions(args.options)
  const text = String(args.text ?? '').trim()
  if (!text) throw new Error('text (the question) is required')
  const allowText = args.allow_text !== false
  const q = await withTopicRetry(d, s, c, cc => postQuestion(d, s, cc, allowText ? text : `${text}`, opts, {
    multi: args.multi === true,
    timeoutMin: int(args.timeout_min),
  }))
  recordOut(d, c, q.messageId, text)
  finishReply(d, s, c)
  return `question sent (question_id: ${q.id}, message_id: ${q.messageId}). The answer arrives as a <channel> event with question_id="${q.id}".`
}

const notifyLog = new Map<string, number[]>()

/** Rate limit per destination: NOTIFY_RATE_PER_MIN messages / minute. */
export function rateLimited(key: string): boolean {
  const now = Date.now()
  const list = (notifyLog.get(key) ?? []).filter(t => now - t < 60_000)
  if (list.length >= settings.notifyRatePerMin) {
    notifyLog.set(key, list)
    return true
  }
  list.push(now)
  notifyLog.set(key, list)
  return false
}

/** Send to a topic (by name/thread) or the session's default target, without any inbound message. */
export async function notify(d: Daemon, s: Session | null, args: Record<string, unknown>): Promise<string> {
  const text = String(args.text ?? '').trim()
  if (!text) throw new Error('text is required')
  const files = (args.files as string[] | undefined) ?? []
  checkFiles(files)
  let c: ChatRef | null
  const topicArg = str(args.topic)
  const groupChat = d.topicsChatId
  if (topicArg && groupChat) {
    const t = d.store.topicByName(groupChat, topicArg)
    if (!t) throw new Error(`topic "${topicArg}" not found`)
    c = { chatId: groupChat, threadId: t.thread_id, isPrivate: false }
  } else if (topicArg && !groupChat) {
    throw new Error('no topics group connected — /connect_group in the bot DM')
  } else if (str(args.chat_id)) {
    c = { chatId: str(args.chat_id)!, threadId: int(args.message_thread_id), isPrivate: !str(args.chat_id)!.startsWith('-') }
  } else {
    c = sessionTarget(d, s)
  }
  if (!c) throw new Error('no destination: pair the bot or pass topic')
  assertAllowedChat(c.chatId)
  if (rateLimited(`${c.chatId}:${c.threadId ?? 0}`)) throw new Error('rate limit: too many notifications to this chat, try later')
  const sendOnce = (cc: ChatRef) => d.bot.api.sendMessage(cc.chatId, text.slice(0, 4096), {
    ...threadOpt(cc), disable_notification: args.silent === true,
  })
  if (args.buttons != null && s) {
    const opts = parseOptions(args.buttons)
    const q = await withTopicRetry(d, s, c, cc => postQuestion(d, s, cc, text, opts, {}))
    return `notified (id: ${q.messageId}, question_id: ${q.id})`
  }
  const sent = s ? await withTopicRetry(d, s, c, sendOnce) : await sendOnce(c)
  recordOut(d, c, sent.message_id, text)
  const ids = [sent.message_id, ...(await sendFiles(d, c, files))]
  return `notified (${idsResult(ids)})`
}

function fmtRows(rows: ReturnType<Daemon['store']['history']>): string {
  if (!rows.length) return '(no messages)'
  return rows.map(m => {
    const t = new Date(m.date * 1000).toISOString().replace('T', ' ').slice(0, 16)
    const who = m.direction === 'out' ? 'bot' : m.from_name ?? m.from_id ?? 'user'
    const extra = [m.kind !== 'text' ? m.kind : null, m.reply_to ? `reply_to=${m.reply_to}` : null, m.quote ? `quote="${m.quote.slice(0, 80)}"` : null]
      .filter(Boolean).join(' ')
    return `#${m.message_id} [${t}] ${who}${extra ? ` (${extra})` : ''}: ${m.text}`
  }).join('\n')
}

function historyChat(d: Daemon, s: Session, args: Record<string, unknown>): ChatRef {
  const topicArg = str(args.topic)
  if (topicArg && d.topicsChatId) {
    const t = d.store.topicByName(d.topicsChatId, topicArg)
    if (!t) throw new Error(`topic "${topicArg}" not found`)
    return { chatId: d.topicsChatId, threadId: t.thread_id, isPrivate: false }
  }
  return resolveChat(d, s, args)
}

export async function handleCall(d: Daemon, s: Session, name: string, args: Record<string, unknown>): Promise<string> {
  if (s.passive && !settings.passiveTools) {
    throw new Error('telegram-bewitched is not registered as a channel in this session (print mode or no --channels flag); its tools are disabled here')
  }
  switch (name) {
    case 'reply':
      return reply(d, s, args)

    case 'ask_user':
      return askUser(d, s, args)

    case 'notify':
      return notify(d, s, args)

    case 'react': {
      const c = resolveChat(d, s, args)
      assertAllowedChat(c.chatId)
      await d.bot.api.setMessageReaction(c.chatId, Number(args.message_id), [{ type: 'emoji', emoji: String(args.emoji) as ReactionTypeEmoji['emoji'] }])
      return 'reacted'
    }

    case 'edit_message': {
      const c = resolveChat(d, s, args)
      assertAllowedChat(c.chatId)
      const parseMode = str(args.format) === 'markdownv2' ? ('MarkdownV2' as const) : undefined
      const id = Number(args.message_id)
      await d.bot.api.editMessageText(c.chatId, id, String(args.text ?? ''), parseMode ? { parse_mode: parseMode } : undefined)
      d.store.updateMessageText(c.chatId, id, String(args.text ?? ''))
      return `edited (id: ${id})`
    }

    case 'download_attachment': {
      const file = await d.bot.api.getFile(String(args.file_id))
      if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
      const res = await fetch(`${settings.apiRoot ?? 'https://api.telegram.org'}/file/bot${d.token}/${file.file_path}`)
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
      const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
      const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    }

    case 'get_history': {
      const c = historyChat(d, s, args)
      const limit = Math.min(int(args.limit) ?? 30, 200)
      return fmtRows(d.store.history(c.chatId, c.threadId ?? null, limit, int(args.before_message_id)))
    }

    case 'search_messages': {
      const q = str(args.query)
      if (!q) throw new Error('query is required')
      const all = args.all_chats === true
      const c = all ? null : historyChat(d, s, args)
      return fmtRows(d.store.search(q, Math.min(int(args.limit) ?? 20, 100), c?.chatId, c ? c.threadId ?? null : undefined))
    }

    case 'get_message': {
      const c = resolveChat(d, s, args)
      const m = d.store.getMessage(c.chatId, Number(args.message_id))
      if (!m) return 'not found in history'
      return JSON.stringify({ ...m, forward: m.forward ? JSON.parse(m.forward) : null }, null, 2)
    }

    case 'remind': {
      const c = resolveChat(d, s, args)
      assertAllowedChat(c.chatId)
      const text = String(args.text ?? '').trim()
      if (!text) throw new Error('text is required')
      const mins = Number(args.in_minutes)
      const at = str(args.at)
      let when: { at: number; daily: boolean } | null = null
      if (Number.isFinite(mins) && mins > 0) when = { at: Date.now() + mins * 60_000, daily: false }
      else if (at) when = parseWhen(`${args.daily === true ? 'каждый день ' : ''}${at} x`)
      if (!when) throw new Error('give in_minutes > 0 or at "HH:MM"')
      const r = addReminder(d, { chatId: c.chatId, threadId: c.threadId, text, at: when.at, daily: when.daily, userId: d.userIdOf(s) ?? owner() ?? c.chatId })
      return `reminder ${r.id} set: ${fmtWhen(r)} (${new Date(r.at).toISOString()})`
    }

    case 'save_memory': {
      const c = resolveChat(d, s, args)
      const text = String(args.text ?? '').trim()
      if (!text) throw new Error('text is required')
      if (text.length > 20_000) throw new Error('memory is limited to 20000 characters')
      mkdirSync(MEMORY_DIR, { recursive: true, mode: 0o700 })
      writeFileSync(memoryPath(c.chatId, c.threadId), text + '\n', { mode: 0o600 })
      return `memory saved for chat ${c.chatId}${c.threadId != null ? ` topic ${c.threadId}` : ''}`
    }

    case 'read_memory': {
      const c = resolveChat(d, s, args)
      return readMemory(c.chatId, c.threadId) ?? '(no memory saved for this chat)'
    }

    case 'list_topics': {
      const chat = d.topicsChatId
      if (!chat) return 'no topics group connected'
      const rows = d.store.topics(chat)
      return rows.map(t => {
        const live = d.sessionForThread(chat, t.thread_id)
        return `thread_id=${t.thread_id} name="${t.name}" status=${t.status} kind=${t.kind}${t.project_key ? ` project=${t.project_key}` : ''}${live ? ` session=#${live.id}` : ''}${topicLink(chat, t.thread_id) ? ` link=${topicLink(chat, t.thread_id)}` : ''}`
      }).join('\n') || '(no topics)'
    }

    case 'create_topic': {
      const chat = d.topicsChatId
      if (!chat) throw new Error('no topics group connected')
      const nameArg = str(args.name)?.slice(0, 128)
      if (!nameArg) throw new Error('name is required')
      const t = await d.bot.api.createForumTopic(chat, nameArg)
      d.store.upsertTopic({ chat_id: chat, thread_id: t.message_thread_id, name: nameArg, kind: 'manual', project_key: null, status: 'active', created_at: Date.now(), last_activity_at: Date.now() })
      return `topic created (thread_id: ${t.message_thread_id})`
    }

    case 'rename_topic': {
      const chat = d.topicsChatId
      if (!chat) throw new Error('no topics group connected')
      await renameTopic(d, chat, Number(args.thread_id), String(args.name ?? ''))
      return 'renamed'
    }

    case 'archive_topic': {
      const chat = d.topicsChatId
      if (!chat) throw new Error('no topics group connected')
      await archiveTopic(d, chat, Number(args.thread_id))
      return 'archived'
    }

    case 'delete_topic': {
      // Destructive: always confirmed by the user with a button.
      const chat = d.topicsChatId
      if (!chat) throw new Error('no topics group connected')
      const thread = Number(args.thread_id)
      const t = d.store.topic(chat, thread)
      if (!t) throw new Error('topic not found')
      const o = owner()
      if (!o) throw new Error('no owner')
      await d.bot.api.sendMessage(o, `Claude (#${s.id} · ${s.projectName}) просит удалить топик «${t.name}» со всеми сообщениями. Удалить?`, {
        reply_markup: new InlineKeyboard([[button('🗑 Удалить', `tp:delok:${thread}`, 'danger'), button('Отмена', 'tp:cancel:0')]]),
      })
      return 'deletion requested — the user must confirm with a button in Telegram'
    }

    default:
      throw new Error(`unknown tool: ${name}`)
  }
}
