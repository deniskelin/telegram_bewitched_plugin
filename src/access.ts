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
import { k, t } from './i18n/index.ts'

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
  /** Stream the answer as it is written (the model writes it as text, then reply with use_last_message). */
  streamAnswer?: boolean
  /** Interface language of the chat (ru, en, es, zh, fr, de); unset — the user's Telegram language or BOT_LANGUAGE. */
  lang?: string
  /** After each turn, a silent line with what it cost (tokens, cache share, $) — from the transcript, no model call. */
  turnCost?: boolean
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
  /** FR-4: role per user id (absent — member; the owner is always the first in allowFrom). */
  roles?: Record<string, 'member' | 'viewer'>
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
      roles: parsed.roles,
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

/** Any paired user (in allowFrom). Rights within that: roleOf / can. */
export function isOwner(userId: string | number, a: Access = loadAccess()): boolean {
  return a.allowFrom.includes(String(userId))
}

/**
 * FR-4 roles. 👑 owner — the first in allowFrom, everything. 👤 member (the
 * default for the others) — writes to sessions, answers ask_user buttons,
 * stops a turn. 👁 viewer — reads only: messages and taps are ignored.
 */
export type Role = 'owner' | 'member' | 'viewer'
export type Action = 'write' | 'answer' | 'stop' | 'control' | 'permissions'

export function roleOf(userId: string | number, a: Access = loadAccess()): Role | null {
  const id = String(userId)
  if (!a.allowFrom.includes(id)) return null
  if (a.allowFrom[0] === id) return 'owner'
  return a.roles?.[id] ?? 'member'
}

export function can(userId: string | number, action: Action, a: Access = loadAccess()): boolean {
  const r = roleOf(userId, a)
  if (r === 'owner') return true
  if (r !== 'member') return false
  return action === 'write' || action === 'answer' || action === 'stop'
}

export function setRole(userId: string, role: 'member' | 'viewer'): void {
  const a = loadAccess()
  a.roles = { ...a.roles, [userId]: role }
  if (role === 'member') delete a.roles[userId]
  saveAccess(a)
}

export function prefsFor(chatId: string, threadId?: number | null, a: Access = loadAccess()): Required<Prefs> {
  const p = a.prefs ?? {}
  const chats = p.chats ?? {}
  const merged = { ...p, ...chats[chatId], ...(threadId != null ? chats[`${chatId}:${threadId}`] : {}) }
  return { verbose: merged.verbose ?? 1, notifyDone: merged.notifyDone ?? 'long', transcript: merged.transcript ?? false, voice: merged.voice ?? 'mirror', ttsVoice: merged.ttsVoice ?? '', ttsSpeed: merged.ttsSpeed ?? 1, lang: merged.lang ?? '', streamAnswer: merged.streamAnswer ?? true, turnCost: merged.turnCost ?? false }
}

const VERBOSE_ICONS = ['🔕', '🔔', '📢'] as const
export const VERBOSE_INFO = [k('только ответ'), k('+ действия'), k('+ текст модели')] as const
export const NOTIFY_DONE_INFO = { off: k('выкл'), long: k('после долгих ходов'), always: k('всегда') } as const

/** 🔕0, 🔔1, 📢2 */
export function verboseBadge(v: 0 | 1 | 2): string {
  return `${VERBOSE_ICONS[v]}${v}`
}

/** "🔔1 · ✅ после долгих ходов" for session cards and /verbose. */
export function prefsBadge(p: Required<Prefs>): string {
  return `${verboseBadge(p.verbose)} · ✅ ${t(NOTIFY_DONE_INFO[p.notifyDone])}`
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
    // 👁 Viewers read only: their messages don't reach sessions.
    if (access.allowFrom.includes(senderId)) return roleOf(senderId, access) === 'viewer' ? { action: 'drop' } : { action: 'deliver', access }
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
    if (roleOf(senderId, access) === 'viewer') return { action: 'drop' }
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
