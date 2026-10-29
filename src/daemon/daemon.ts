/**
 * The shared daemon. Exactly one per state dir: it alone polls getUpdates,
 * owns the SQLite store and routes Telegram traffic to the Claude Code
 * sessions connected over the unix socket.
 */

import { holdIfPaused } from './outoftokens.ts'
import type { Socket } from 'bun'
import { Bot, GrammyError } from 'grammy'
import { randomBytes } from 'crypto'
import { chmodSync, existsSync, readFileSync, rmSync } from 'fs'
import { basename, join, relative } from 'path'
import { loadAccess, owner, prefsFor } from '../access.ts'
import { DB_FILE, LEGACY_STATE_DIR, PROTOCOL_VERSION, SOCK_FILE, settings } from '../config.ts'
import { Store, type TopicRow } from '../db.ts'
import { LineDecoder, encode, type ClientMsg, type DaemonMsg, type Hello } from '../ipc.ts'
import { cmdlineOf, isAlive } from '../proc.ts'
import { createBot } from '../tg.ts'
import { Streams } from './stream.ts'
import { installLang } from './lang.ts'
import { t } from '../i18n/index.ts'
import { installQuietHours } from './quiet.ts'
import { tmuxCapture, tmuxKeys, tmuxPaneId, tmuxKillWindow, tmuxLaunch, tmuxType, tmuxLocation, type LaunchOptions, type TmuxLocation } from './launch.ts'

/** Queue for messages to the main session while it is not running. */
export const MAIN_PENDING_KEY = '__main__'

/** Pending queue of a user's session. */
export function userPendingKey(userId: string): string {
  return `user:${userId}`
}

export type ChatRef = { chatId: string; threadId?: number; isPrivate: boolean }

/** An extra forum group for project topics (FR-3). */
export type TopicGroup = { chatId: string; title: string; paths: string[] }

export type Session = {
  id: string
  sock: Socket<SockData>
  claudePid: number | null
  cwd: string
  projectKey: string
  projectName: string
  branch: string | null
  tmuxPane: string | null
  passive: boolean
  connectedAt: number
  lastActivity: number
  status: 'idle' | 'working' | 'waiting'
  topic: { chatId: string; threadId: number; name: string } | null
  /** The model's text since its last tool call in this turn: the answer being written (FR-1). */
  answer: string
  /** An ordinary group bound to this session's project (groups.ts): the session answers there. */
  group: { chatId: string; title: string } | null
  lastChat: ChatRef | null
  turn: { start: number; replied: boolean } | null
  /** Notes prepended to the next inbound message (e.g. "you were stopped"). */
  notes: string[]
  reconnect: boolean
  /** From hooks: Claude's own session id (for --resume), transcript, permission mode. */
  claude: { sessionId: string | null; transcript: string | null; permissionMode: string | null }
  lastTool: { text: string; at: number } | null
  /** Tools the owner allowed for the rest of this session ("♾ Всегда"); asked again after a reconnect. */
  alwaysAllow: Set<string>
  /** The "context is filling up" notice went out (reset when the context shrinks). */
  contextWarned: boolean
  /** Command line of the Claude process, read at connect (it is gone once the process exits). */
  argv: string[]
}

export type UserInfo = { first?: string; last?: string; username?: string }

export type SockData = { decoder: LineDecoder; session: Session | null }

export type PendingPermission = {
  sessionId: string
  tool_name: string
  description: string
  input_preview: string
}

export class Daemon {
  readonly bot: Bot
  readonly store: Store
  readonly sessions = new Map<string, Session>()
  readonly permissions = new Map<string, PendingPermission>()
  readonly streams: Streams
  botUsername = ''
  botId = 0
  private polling = false
  private lastClientGone = Date.now()

  constructor(readonly token: string, dbFile = DB_FILE) {
    this.bot = createBot(token, settings.apiRoot)
    this.store = new Store(dbFile)
    this.streams = new Streams(this)
    installQuietHours(this, this.bot)
  }

  log(msg: string): void {
    process.stderr.write(`${new Date().toISOString()} ${msg}\n`)
  }

  // --- topics chat (forum supergroup) ---

  get topicsChatId(): string | null {
    return this.store.get('topics_chat_id')
  }

  /**
   * FR-3: more forum groups for project topics. The main one (topicsChatId)
   * keeps General and the pinned panel; each extra one takes the projects
   * under its folders (longest match wins) and the topics created in it.
   */
  extraTopicGroups(): TopicGroup[] {
    try {
      const v = JSON.parse(this.store.get('topic_groups') ?? '[]')
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  }

  setExtraTopicGroups(list: TopicGroup[]): void {
    this.store.set('topic_groups', list.length ? JSON.stringify(list) : null)
  }

  /** Every topics group, the main one first. */
  topicChats(): string[] {
    const main = this.topicsChatId
    return [...(main ? [main] : []), ...this.extraTopicGroups().map(g => g.chatId).filter(c => c !== main)]
  }

  isTopicsChat(chatId: string): boolean {
    return this.topicChats().includes(chatId)
  }

  /** The group a project's topic belongs in: an extra group whose folder holds it, else the main one. */
  topicsChatFor(projectKey: string): string | null {
    let best: { chatId: string; len: number } | null = null
    for (const g of this.extraTopicGroups()) {
      for (const p of g.paths) {
        if ((projectKey === p || projectKey.startsWith(p.endsWith('/') ? p : p + '/')) && (!best || p.length > best.len)) best = { chatId: g.chatId, len: p.length }
      }
    }
    return best?.chatId ?? this.topicsChatId
  }

  /** True when only paired users can post in the topics group — safe to show permission buttons there. */
  topicsGroupIsStrict(chatId: string | null = this.topicsChatId): boolean {
    const chat = chatId
    if (!chat) return false
    const a = loadAccess()
    const g = a.groups[chat]
    if (!g) return false
    if (g.allowPaired) return true
    return g.allowFrom.length > 0 && g.allowFrom.every(id => a.allowFrom.includes(id))
  }



  // --- sessions ---

  activeSessions(): Session[] {
    return [...this.sessions.values()].filter(s => !s.passive)
  }

  sessionForProject(projectKey: string): Session | null {
    const list = this.activeSessions().filter(s => s.projectKey === projectKey)
    list.sort((a, b) => b.connectedAt - a.connectedAt)
    return list[0] ?? null
  }

  sessionForThread(chatId: string, threadId: number): Session | null {
    const direct = this.activeSessions().find(s => s.topic?.chatId === chatId && s.topic.threadId === threadId)
    if (direct) return direct
    const t = this.store.topic(chatId, threadId)
    return t?.project_key ? this.sessionForProject(t.project_key) : null
  }

  sessionByClaudePid(pid: number): Session | null {
    const all = [...this.sessions.values()].filter(s => s.claudePid === pid)
    return all.find(s => !s.passive) ?? all[0] ?? null
  }

  /** Folder of the main session: picked with /main, else MAIN_DIR. */
  mainKey(): string {
    return this.store.get('main_dir') ?? settings.mainDir
  }

  isMain(s: Session): boolean {
    const key = this.mainKey()
    return s.projectKey === key || s.cwd === key
  }

  /** The allowlisted user a session belongs to: it runs in USERS_DIR/<user_id>. */
  userIdOf(s: Session): string | null {
    if (!settings.userSessions) return null
    const m = /^(\d+)$/.exec(relative(settings.usersDir, s.cwd))
    return m ? m[1] : null
  }

  /** Telegram profile of a user as last seen (messages, invite, getChat). */
  userInfo(userId: string): UserInfo | null {
    try {
      return JSON.parse(this.store.get(`user_info:${userId}`) ?? 'null')
    } catch {
      return null
    }
  }

  rememberUser(userId: string, info: UserInfo): void {
    const clean: UserInfo = {
      ...(info.first ? { first: info.first } : {}),
      ...(info.last ? { last: info.last } : {}),
      ...(info.username ? { username: info.username } : {}),
    }
    const json = JSON.stringify(clean)
    if (json !== '{}' && this.store.get(`user_info:${userId}`) !== json) this.store.set(`user_info:${userId}`, json)
  }

  /** "Денис Келин (@deniskelin, 140211098)": full name, username if any, and the id. */
  userLabel(userId: string): string {
    const i = this.userInfo(userId)
    const name = [i?.first, i?.last].filter(Boolean).join(' ') || this.store.get(`user_name:${userId}`) || this.store.lastSenderName(userId)
    if (name && name !== i?.username) return `${name} (${[i?.username ? `@${i.username}` : null, userId].filter(Boolean).join(', ')})`
    return i?.username ? `@${i.username} (${userId})` : userId
  }

  userSession(userId: string): Session | null {
    const list = this.activeSessions().filter(s => this.userIdOf(s) === userId)
    list.sort((a, b) => b.connectedAt - a.connectedAt)
    return list[0] ?? null
  }

  /** main: DMs (without user sessions), General, topics without a project; user: one user's DMs; project: its topic. */
  roleOf(s: Session): 'main' | 'user' | 'project' {
    if (this.userIdOf(s)) return 'user'
    return this.isMain(s) ? 'main' : 'project'
  }

  /** Sessions ended on purpose (archive, idle timeout): the watchdog stays quiet for them. */
  readonly ending = new Set<string>()

  /** Launches not yet connected, by dir: no second tmux window while the first waits for confirmation. */
  readonly launching = new Map<string, number>()

  /** Session for DMs, General and topics without a session of their own. */
  mainSession(): Session | null {
    const list = this.activeSessions().filter(s => this.isMain(s))
    list.sort((a, b) => b.connectedAt - a.connectedAt)
    return list[0] ?? null
  }

  send(session: Session, msg: DaemonMsg): void {
    try {
      session.sock.write(encode(msg))
    } catch (err) {
      this.log(`send to session ${session.id} failed: ${err}`)
    }
  }

  /** Push a Telegram message into a session as a <channel> event. */
  deliver(session: Session, content: string, meta: Record<string, string>, from?: ChatRef): void {
    if (session.notes.length) {
      content = session.notes.map(n => `[${n}]`).join('\n') + '\n\n' + content
      session.notes = []
    }
    // Out of tokens: the message waits for the reset (outoftokens.ts).
    if (from && holdIfPaused(this, session, content, meta, from)) return
    // FR-1: tell the model the chat streams the answer, so it writes it as text and replies with use_last_message.
    if (from && prefsFor(from.chatId, from.threadId).streamAnswer) meta = { ...meta, stream_answer: 'true' }
    this.send(session, { t: 'inbound', content, meta })
    session.lastActivity = Date.now()
    if (from) {
      session.answer = ''
      session.lastChat = from
      if (!session.turn) session.turn = { start: Date.now(), replied: false }
      session.status = 'working'
      this.streams.open(session, from)
    }
    this.onSessionsChanged()
  }

  // Overridden by topics module.
  onSessionsChanged: () => void = () => {}
  onSessionRegistered: (s: Session) => Promise<void> = async () => {}
  onSessionGone: (s: Session) => void = () => {}
  handleCall: (s: Session, name: string, args: Record<string, unknown>) => Promise<string> = async () => 'not ready'
  handlePermissionRequest: (s: Session, p: Omit<PendingPermission, 'sessionId'> & { request_id: string }) => void = () => {}
  /** "chat:thread" → the last message there was spoken (voice, video note): /voice mirror answers by voice. */
  readonly lastSpeech = new Map<string, boolean>()

  /** Hand text to whichever session serves the chat, as a message from fromId (queue/launch if needed). Set by inbound. */
  routeText: (chat: ChatRef, fromId: string, text: string, meta: Record<string, string>) => Promise<void> = async () => {}
  /** Start a Claude Code session in dir; returns the tmux window. Replaced in tests. */
  launchSession: (dir: string, o?: LaunchOptions) => Promise<string> = tmuxLaunch
  /** Where a tmux pane lives. Replaced in tests. */
  tmuxLocation: (pane: string) => Promise<TmuxLocation | null> = tmuxLocation
  /** Screen of a pane/window and key presses into it. Replaced in tests. */
  tmuxCapture: (target: string) => Promise<string | null> = tmuxCapture
  tmuxKeys: (target: string, keys: string[]) => Promise<void> = tmuxKeys
  /** Type a line (e.g. "/compact") into a pane and press Enter. Replaced in tests. */
  tmuxType: (target: string, text: string) => Promise<void> = tmuxType
  tmuxKillWindow: (target: string) => Promise<void> = tmuxKillWindow
  /** Pane id (%N) of a tmux window. Replaced in tests. */
  tmuxPaneId: (target: string) => Promise<string | null> = tmuxPaneId

  private register(sock: Socket<SockData>, h: Hello): Session {
    const projectKey = h.projectRoot || h.cwd
    let id: string
    do id = randomBytes(2).toString('hex')
    while (this.sessions.has(id))
    const s: Session = {
      id,
      sock,
      claudePid: h.claudePid,
      cwd: h.cwd,
      projectKey,
      projectName: basename(projectKey) || projectKey,
      branch: h.branch,
      tmuxPane: h.tmuxPane,
      passive: h.passive,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      status: 'idle',
      topic: null,
      group: null,
      answer: '',
      lastChat: null,
      turn: null,
      notes: [],
      claude: { sessionId: null, transcript: null, permissionMode: null },
      lastTool: null,
      contextWarned: false,
      alwaysAllow: new Set(),
      argv: h.claudePid ? cmdlineOf(h.claudePid) : [],
      // The daemon may have restarted (and lost its memory) while this Claude
      // process kept running: remember greeted processes in the store.
      reconnect: h.reconnect === true || (h.claudePid != null && this.store.get(`greeted:${h.claudePid}`) != null),
    }
    this.sessions.set(id, s)
    this.log(`session ${id} connected: ${projectKey}${h.passive ? ' (passive)' : ''} pid=${h.claudePid}`)
    return s
  }

  private unregister(s: Session): void {
    if (!this.sessions.delete(s.id)) return
    this.streams.close(s, 'gone')
    for (const [rid, p] of this.permissions) if (p.sessionId === s.id) this.permissions.delete(rid)
    this.log(`session ${s.id} disconnected`)
    if (this.sessions.size === 0) this.lastClientGone = Date.now()
    this.onSessionGone(s)
    this.onSessionsChanged()
  }

  // --- IPC server ---

  /** Forget greeted Claude processes that are gone (pids get recycled). */
  pruneGreeted(): void {
    for (const k of this.store.keys('greeted:')) {
      const pid = Number(k.slice('greeted:'.length))
      if (!isAlive(pid) || !cmdlineOf(pid).length) this.store.set(k, null)
    }
  }

  listen(sockFile = SOCK_FILE): void {
    rmSync(sockFile, { force: true })
    const daemon = this
    Bun.listen<SockData>({
      unix: sockFile,
      socket: {
        open(sock) {
          sock.data = { decoder: new LineDecoder(), session: null }
        },
        data(sock, chunk) {
          for (const raw of sock.data.decoder.push(chunk.toString())) void daemon.onClientMsg(sock, raw as ClientMsg)
        },
        close(sock) {
          if (sock.data.session) daemon.unregister(sock.data.session)
        },
        error(sock, err) {
          daemon.log(`socket error: ${err}`)
        },
      },
    })
    try {
      // Bun creates the socket with the process umask; lock it to the owner.
      chmodSync(sockFile, 0o600)
    } catch {}
    setInterval(() => {
      for (const s of this.sessions.values()) this.send(s, { t: 'ping' })
    }, 15_000).unref()
  }

  private async onClientMsg(sock: Socket<SockData>, msg: ClientMsg): Promise<void> {
    const s = sock.data.session
    switch (msg.t) {
      case 'hello': {
        if (msg.protocol !== PROTOCOL_VERSION) {
          sock.write(encode({ t: 'error', message: `protocol ${msg.protocol} unsupported, daemon speaks ${PROTOCOL_VERSION}` }))
          return
        }
        if (s) return
        const session = this.register(sock, msg)
        sock.data.session = session
        try {
          await this.onSessionRegistered(session)
        } catch (err) {
          this.log(`session ${session.id} setup failed: ${err}`)
        }
        if (session.claudePid != null) this.store.set(`greeted:${session.claudePid}`, String(Date.now()))
        this.send(session, { t: 'welcome', session: session.id, topic: session.topic })
        this.onSessionsChanged()
        return
      }
      case 'call': {
        if (!s) return
        s.lastActivity = Date.now()
        try {
          const text = await this.handleCall(s, msg.name, msg.args ?? {})
          this.send(s, { t: 'result', id: msg.id, ok: true, text })
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err)
          this.send(s, { t: 'result', id: msg.id, ok: false, text })
        }
        return
      }
      case 'perm_req': {
        if (!s) return
        this.handlePermissionRequest(s, msg)
        return
      }
      case 'pong':
        return
    }
  }

  // --- polling ---

  /**
   * The official plugin polls with its own server.ts. If it runs with the
   * same token, polling here would 409 both of them — wait instead.
   */
  legacyConflict(): boolean {
    try {
      const pid = parseInt(readFileSync(join(LEGACY_STATE_DIR, 'bot.pid'), 'utf8'), 10)
      if (!(pid > 1) || !isAlive(pid) || !cmdlineOf(pid).join(' ').includes('server.ts')) return false
      const legacyEnv = readFileSync(join(LEGACY_STATE_DIR, '.env'), 'utf8')
      return legacyEnv.includes(`TELEGRAM_BOT_TOKEN=${this.token}`)
    } catch {
      return false
    }
  }

  async startPolling(register: (bot: Bot) => void): Promise<void> {
    const me = await this.bot.api.getMe()
    this.botUsername = me.username
    this.botId = me.id
    installLang(this, this.bot)
    register(this.bot)
    let warned = false
    for (let attempt = 1; ; attempt++) {
      if (this.legacyConflict()) {
        if (!warned) {
          this.log('official telegram plugin is polling the same token — waiting for it to stop')
          this.warnOwner(t('⚠️ Официальный плагин telegram опрашивает этого же бота, поэтому telegram-bewitched ждёт. Отключите его: `claude plugin disable telegram@claude-plugins-official` (и `telegram@synced`, если он синхронизирован с claude.ai).'))
        }
        warned = true
        await new Promise(r => setTimeout(r, 30_000))
        attempt = 0
        continue
      }
      try {
        this.polling = true
        await this.bot.start({
          allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member', 'stopped_message_generation'] as never,
          drop_pending_updates: false,
          onStart: info => {
            attempt = 0
            this.log(`polling as @${info.username}`)
          },
        })
        return
      } catch (err) {
        this.polling = false
        if (err instanceof Error && err.message === 'Aborted delay') return
        const is409 = err instanceof GrammyError && err.error_code === 409
        if (is409 && attempt === 3) {
          this.warnOwner(t('⚠️ Другой процесс опрашивает этого бота (409 Conflict), сообщения до сессий не доходят. Частая причина — включённый официальный плагин telegram (в том числе `telegram@synced` с claude.ai). Проверьте: `claude plugin list`.'))
        }
        const delay = Math.min(1000 * attempt, 15_000)
        this.log(`${is409 ? '409 Conflict — another poller holds the token' : `polling error: ${err}`}; retry in ${delay / 1000}s`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  /** DM the owner (sending works even while another process holds getUpdates). At most once per 10 min. */
  private lastWarn = 0
  warnOwner(text: string): void {
    const o = owner()
    if (!o || Date.now() - this.lastWarn < 600_000) return
    this.lastWarn = Date.now()
    void this.bot.api.sendMessage(o, text).catch(() => {})
  }

  isPolling(): boolean {
    return this.polling
  }

  /** Exit after DAEMON_IDLE_EXIT_MIN without clients (0 = never). */
  startIdleWatch(onExit: () => void): void {
    setInterval(() => {
      const min = settings.idleExitMin
      if (min > 0 && this.sessions.size === 0 && Date.now() - this.lastClientGone > min * 60_000) onExit()
    }, 30_000).unref()
  }

  /** Topic row for a session's project in the topics group, if any. */
  topicRowFor(s: Session): TopicRow | null {
    for (const chat of this.topicChats()) {
      const row = this.store.topicForProject(chat, s.projectKey)
      if (row) return row
    }
    return null
  }

  socketExists(): boolean {
    return existsSync(SOCK_FILE)
  }
}
