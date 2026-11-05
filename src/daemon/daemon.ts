import { bindTask, startStage, recoverTaskCosts } from './taskcost.ts'
/**
 * The shared daemon. Exactly one per state dir: it alone polls getUpdates,
 * owns the SQLite store and routes Telegram traffic to the Claude Code
 * sessions connected over the unix socket.
 */

import { deliveryPhase, rememberSession, startUx } from './ux.ts'
import { installEconomy, restoreTextBatches, countEconomy, rememberContext } from './economy.ts'
import { holdIfPaused } from './outoftokens.ts'
import type { Socket } from 'bun'
import { Bot, GrammyError } from 'grammy'
import { randomBytes } from 'crypto'
import { chmodSync, existsSync, readFileSync, rmSync } from 'fs'
import { basename, join, relative } from 'path'
import { loadAccess, owner, prefsFor, roleOf } from '../access.ts'
import { DB_FILE, LEGACY_STATE_DIR, PROTOCOL_VERSION, SOCK_FILE, settings } from '../config.ts'
import { Store, type TopicRow } from '../db.ts'
import { LineDecoder, encode, type ClientMsg, type DaemonMsg, type Hello } from '../ipc.ts'
import { cmdlineOf, isAlive } from '../proc.ts'
import { createBot } from '../tg.ts'
import { Streams } from './stream.ts'
import { installLang } from './lang.ts'
import { t } from '../i18n/index.ts'
import { installQuietHours } from './quiet.ts'
import { channelText, codexDeliver, codexQueue, codexUndelivered, codexTakeHeldEntries, holdForCodex, withProjectEngine, type EngineId } from './engines.ts'
import { tmuxCapture, tmuxKeys, tmuxPaneId, tmuxKillWindow, tmuxLaunch, tmuxType, tmuxLocation, type LaunchOptions, type TmuxLocation, type TypeOptions } from './launch.ts'
import { sendNotice } from './journal.ts'
import { pendingKeyOf } from './topics.ts'
import { turnStarted } from './turnfiles.ts'

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
  /** The current turn is the daemon's own errand (the FR-16 handoff summary): no «✅ Готово» or turn cost for it. */
  quietTurn?: boolean
  /** FR-12: the last plan of the session (TodoWrite). */
  plan?: import('./stream.ts').PlanItem[]
  lastActivity: number
  status: 'idle' | 'working' | 'waiting'
  topic: { chatId: string; threadId: number; name: string } | null
  /** The model's text since its last tool call in this turn: the answer being written (FR-1). */
  answer: string
  /** An ordinary group bound to this session's project (groups.ts): the session answers there. */
  group: { chatId: string; title: string } | null
  lastChat: ChatRef | null
  /** The last answer sent as one message (rich Markdown or plain text): the turn cost is appended to it (FR-11). */
  /** kb: the answer's keyboard (📋 copy buttons): an edit without it would take them off. */
  lastAnswer: { chatId: string; messageId: number; at: number; markdown?: string; text?: string; kb?: unknown } | null
  /** stuck: «не берёт сообщение» went out for this turn (watchdog.ts checkTurns). */
  /** byHook: opened by a tool call, not a prompt (a turn begun in the terminal, or a daemon restart mid-turn). */
  turn: { start: number; replied: boolean; stuck?: boolean; byHook?: boolean } | null
  /** The last hook event of this session: a sign of life. */
  lastHookAt: number
  /** The agent CLI behind it (FR-15); everything connecting over the channel is Claude Code. */
  engine: EngineId
  /** Set when ⏹ interrupted the turn: late hooks of that turn must not mark it working again. Cleared by the next prompt. */
  stopRequest?: { at: number; phase: 'sent' | 'confirmed' | 'failed' }
  stoppedAt: number | null
  /**
   * When the last turn ended (the Stop hook fired). Each hook is a process of its own, so the
   * turn's last MessageDisplay can reach the daemon after its Stop: such a late hook must not
   * open a turn nobody will close («работает» while idle).
   */
  turnEndedAt?: number
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

  /** The allowlisted user a session belongs to: it runs in USERS_DIR/<user_id>. */
  userIdOf(s: Session): string | null {
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

  /** Just the name: first and last name, else @username, else the id — for buttons. */
  userShortName(userId: string): string {
    const i = this.userInfo(userId)
    return [i?.first, i?.last].filter(Boolean).join(' ') || this.store.get(`user_name:${userId}`) || this.store.lastSenderName(userId) || (i?.username ? `@${i.username}` : userId)
  }

  userSession(userId: string): Session | null {
    const list = this.activeSessions().filter(s => this.userIdOf(s) === userId)
    list.sort((a, b) => b.connectedAt - a.connectedAt)
    return list[0] ?? null
  }

  /** user: one user's DMs and their own messages in General; project: its topic or group. */
  roleOf(s: Session): 'user' | 'project' {
    return this.userIdOf(s) ? 'user' : 'project'
  }

  /** Sessions ended on purpose (archive, idle timeout): the watchdog stays quiet for them. */
  readonly ending = new Set<string>()

  /** Launches not yet connected, by dir: no second tmux window while the first waits for confirmation. */
  readonly launching = new Map<string, number>()
  /** dir → the tmux window of its pending launch (launch.ts noteLaunch). */
  readonly launchWindows = new Map<string, string>()

  send(session: Session, msg: DaemonMsg): void {
    try {
      session.sock.write(encode(msg))
    } catch (err) {
      this.log(`send to session ${session.id} failed: ${err}`)
    }
  }

  /** Push a Telegram message into a session as a <channel> event. */
  deliver(session: Session, content: string, meta: Record<string, string>, from?: ChatRef): void {
    if (from && meta.user_id) bindTask(this, from, meta.user_id, meta)
    countEconomy(this, 'delivery_requests')
    countEconomy(this, 'bridge_input_chars', content.length)
    if (session.notes.length) {
      content = session.notes.map(n => `[${n}]`).join('\n') + '\n\n' + content
      session.notes = []
    }
    // F08: every event from a person says who they are now (a button answer, a reminder, a queued message too) —
    // the role at delivery, not when the event was made. Events with no person (session_message) get none.
    if (/^\d+$/.test(meta.user_id ?? '') && !meta.user_role) meta = { ...meta, user_role: roleOf(meta.user_id) ?? 'guest' }
    // Out of tokens: the message waits for the reset (outoftokens.ts).
    if (from && holdIfPaused(this, session, content, meta, from)) { deliveryPhase(this, meta, 'queued', session); return }
    if (from) meta = { ...meta, answer_detail: prefsFor(from.chatId, from.threadId).answerDetail }
    // FR-1: tell the model the chat streams the answer, so it writes it as text and replies with use_last_message.
    if (from && session.engine === 'claude' && prefsFor(from.chatId, from.threadId).streamAnswer) meta = { ...meta, stream_answer: 'true' }
    // Codex has no channel: the message goes into its thread with codex queue (FR-16).
    if (session.engine === 'codex') {
      // FR-16: during a turn messages are held and go in as one after it (codexFlushHeld) — one turn, not N.
      if (session.turn && meta.event == null && (session.lastHookAt ?? 0) >= session.turn.start && holdForCodex(this, session, channelText(content, meta), from, meta)) {
        deliveryPhase(this, meta, 'queued', session)
        this.log(`message from ${from?.chatId ?? '?'} held for codex session ${session.id} until its turn ends`)
        return
      }
      startStage(this, session, meta)
      void codexDeliver(this, session, channelText(content, meta)).then(() => {
        deliveryPhase(this, meta, 'sent', session)
        if (meta.message_id) rememberContext(this, session, meta.chat_id ?? from?.chatId ?? '', (meta.message_ids ?? meta.message_id).split(','))
      }).catch(err => { deliveryPhase(this, meta, 'failed', session); codexUndelivered(this, session, err, from) })
    }
    else {
      startStage(this, session, meta)
      this.send(session, { t: 'inbound', content, meta })
      deliveryPhase(this, meta, 'sent', session)
      if (meta.message_id) rememberContext(this, session, meta.chat_id ?? from?.chatId ?? '', (meta.message_ids ?? meta.message_id).split(','))
    }
    if (from) this.log(`message from ${from.chatId}${from.threadId ? `/${from.threadId}` : ''} → session ${session.id}${session.status === 'idle' ? '' : ` (${session.status})`}`)
    session.lastActivity = Date.now()
    session.stoppedAt = null
    session.stopRequest = undefined
    if (from) {
      session.answer = ''
      session.lastChat = from
      if (!session.turn) { session.turn = { start: Date.now(), replied: false }; turnStarted(session) }
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
  /** Start a session in dir with the project's engine and model; returns the tmux window. Replaced in tests. */
  launchSession: (dir: string, o?: LaunchOptions) => Promise<string> = (dir, o) => tmuxLaunch(dir, withProjectEngine(this, dir, o))
  /** Where a tmux pane lives. Replaced in tests. */
  tmuxLocation: (pane: string) => Promise<TmuxLocation | null> = tmuxLocation
  /** Screen of a pane/window and key presses into it. Replaced in tests. */
  tmuxCapture: (target: string) => Promise<string | null> = tmuxCapture
  tmuxKeys: (target: string, keys: string[]) => Promise<void> = tmuxKeys
  /** Type a line (e.g. "/compact") into a pane and press Enter. Replaced in tests. */
  tmuxType: (target: string, text: string, o?: TypeOptions) => Promise<void> = (target, text, o) => tmuxType(target, text, undefined, o)
  tmuxKillWindow: (target: string) => Promise<void> = tmuxKillWindow
  /** A message into a Codex thread (FR-16). Replaced in tests. */
  codexQueue: (thread: string, text: string) => Promise<void> = codexQueue
  /** Pane id (%N) of a tmux window. Replaced in tests. */
  tmuxPaneId: (target: string) => Promise<string | null> = tmuxPaneId

  private register(sock: Socket<SockData>, h: Hello): Session {
    const projectKey = h.projectRoot || h.cwd
    let id: string
    do id = randomBytes(4).toString('hex')
    while (this.sessions.has(id) || this.store.get(`ux:alias:${id}`) != null)
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
      lastHookAt: 0,
      engine: h.engine === 'codex' ? 'codex' : 'claude',
      status: 'idle',
      topic: null,
      group: null,
      answer: '',
      lastChat: null,
      lastAnswer: null,
      turn: null,
      stoppedAt: null,
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
    rememberSession(this, s)
    this.log(`session ${id} connected: ${projectKey}${h.passive ? ' (passive)' : ''} pid=${h.claudePid}`)
    return s
  }

  private unregister(s: Session): void {
    if (!this.sessions.delete(s.id)) return
    this.streams.close(s, 'gone')
    for (const [rid, p] of this.permissions) if (p.sessionId === s.id) this.permissions.delete(rid)
    this.log(`session ${s.id} disconnected`)
    // FR-16: messages held for the end of a Codex turn wait for the next session instead of being lost.
    for (const item of codexTakeHeldEntries(s)) this.store.addPending(pendingKeyOf(this, s), item.content, item.meta)
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
          countEconomy(this, 'tool_calls')
          countEconomy(this, 'tool_result_chars', text.length)
          this.send(s, { t: 'result', id: msg.id, ok: true, text })
        } catch (err) {
          countEconomy(this, 'tool_errors')
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
    installEconomy(this, this.bot)
    startUx(this)
    recoverTaskCosts(this)
    register(this.bot)
    restoreTextBatches(this)
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

  /** Warn the owner, in the journal if there is one (sending works even while another process holds getUpdates). At most once per 10 min. */
  private lastWarn = 0
  warnOwner(text: string): void {
    if (Date.now() - this.lastWarn < 600_000) return
    this.lastWarn = Date.now()
    void sendNotice(this, 'daemon', () => text, () => ({ parse_mode: undefined }))
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
