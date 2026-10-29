/**
 * Access control, ported from the official plugin: pairing, allowlists,
 * group policies. State in STATE_DIR/access.json, managed by the
 * /telegram-bewitched:access skill. Adds per-chat UX prefs.
 */

import { randomBytes } from 'crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { join, sep } from 'path'
import type { Context } from 'grammy'
import { ACCESS_FILE, STATE_DIR } from './config.ts'

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
  /** Anyone in the global allowFrom may post here (the topics group): every paired user has full control. */
  allowPaired?: boolean
}

export type Prefs = {
  /** 0 = only "thinking" + answer, 1 = + tool lines, 2 = + model text. */
  verbose?: 0 | 1 | 2
  /** Auto "done" notice after a turn. */
  notifyDone?: 'off' | 'long' | 'always'
  /** Show the transcript of a voice message in the chat. */
  transcript?: boolean
  /** Answer by voice: never, when the user spoke, or always. */
  voice?: 'off' | 'mirror' | 'always'
  /** Voice of the TTS provider for this chat ("" = TTS_VOICE). */
  ttsVoice?: string
  /** Speech rate, 0.5–2 (1 = as synthesized). */
  ttsSpeed?: number
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  /** Global prefs, plus overrides keyed by "chatId" or "chatId:threadId". */
  prefs?: Prefs & { chats?: Record<string, Prefs> }
}

const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      prefs: parsed.prefs,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write('telegram-bewitched: access.json is corrupt, moved aside. Starting fresh.\n')
    return defaultAccess()
  }
}

// Static mode snapshots access at boot; pairing needs runtime mutation so it
// downgrades to allowlist.
const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') a.dmPolicy = 'allowlist'
      a.pending = {}
      return a
    })()
  : null

export function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

export function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

export function owner(a: Access = loadAccess()): string | undefined {
  return a.allowFrom[0]
}

export function isOwner(userId: string | number, a: Access = loadAccess()): boolean {
  return a.allowFrom.includes(String(userId))
}

export function prefsFor(chatId: string, threadId?: number | null, a: Access = loadAccess()): Required<Prefs> {
  const p = a.prefs ?? {}
  const chats = p.chats ?? {}
  const merged = { ...p, ...chats[chatId], ...(threadId != null ? chats[`${chatId}:${threadId}`] : {}) }
  return { verbose: merged.verbose ?? 1, notifyDone: merged.notifyDone ?? 'long', transcript: merged.transcript ?? false, voice: merged.voice ?? 'mirror', ttsVoice: merged.ttsVoice ?? '', ttsSpeed: merged.ttsSpeed ?? 1 }
}

const VERBOSE_ICONS = ['🔕', '🔔', '📢'] as const
export const VERBOSE_INFO = ['только ответ', '+ действия', '+ текст модели'] as const
export const NOTIFY_DONE_INFO = { off: 'выкл', long: 'после долгих ходов', always: 'всегда' } as const

/** 🔕0, 🔔1, 📢2 */
export function verboseBadge(v: 0 | 1 | 2): string {
  return `${VERBOSE_ICONS[v]}${v}`
}

/** "🔔1 · ✅ после долгих ходов" for session cards and /verbose. */
export function prefsBadge(p: Required<Prefs>): string {
  return `${verboseBadge(p.verbose)} · ✅ ${NOTIFY_DONE_INFO[p.notifyDone]}`
}

export function setPref(chatKey: string | null, patch: Prefs): void {
  const a = loadAccess()
  a.prefs ??= {}
  if (chatKey == null) Object.assign(a.prefs, patch)
  else {
    a.prefs.chats ??= {}
    a.prefs.chats[chatKey] = { ...a.prefs.chats[chatKey], ...patch }
  }
  saveAccess(a)
}

/** Outbound gate — tools can only target chats the inbound gate would deliver from. */
export function assertAllowedChat(chat_id: string): void {
  const access = loadAccess()
  if (access.allowFrom.includes(chat_id)) return
  if (chat_id in access.groups) return
  throw new Error(`chat ${chat_id} is not allowlisted — add via /telegram-bewitched:access`)
}

/** The server's own state is the one thing Claude has no reason to ever send. */
export function assertSendable(f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch {
    return
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export function gate(ctx: Context, botUsername: string): GateResult {
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)
  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = { senderId, chatId: String(ctx.chat!.id), createdAt: now, expiresAt: now + 60 * 60 * 1000, replies: 1 }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const policy = access.groups[String(ctx.chat!.id)]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    if (policy.allowPaired) {
      if (!access.allowFrom.includes(senderId) && !groupAllowFrom.includes(senderId)) return { action: 'drop' }
    } else if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop' }
    if ((policy.requireMention ?? true) && !isMentioned(ctx, botUsername, access.mentionPatterns)) return { action: 'drop' }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

/** Like gate() but for bot commands: no pairing side effects. */
export function dmCommandGate(ctx: Context): { access: Access; senderId: string } | null {
  if (ctx.chat?.type !== 'private' || !ctx.from) return null
  const senderId = String(ctx.from.id)
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)
  if (access.dmPolicy === 'disabled') return null
  if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return null
  return { access, senderId }
}

export function isMentioned(ctx: Context, botUsername: string, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) return true
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}
