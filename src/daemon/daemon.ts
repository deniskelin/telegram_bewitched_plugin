/**
 * The shared daemon. Exactly one per state dir: it alone polls getUpdates,
 * owns the SQLite store and routes Telegram traffic to the Claude Code
 * sessions connected over the unix socket.
 */

import type { Socket } from 'bun'
import { Bot, GrammyError } from 'grammy'
import { randomBytes } from 'crypto'
import { chmodSync, existsSync, readFileSync, rmSync } from 'fs'
import { basename, join } from 'path'
import { loadAccess, owner } from '../access.ts'
import { DB_FILE, LEGACY_STATE_DIR, PROTOCOL_VERSION, SOCK_FILE, settings } from '../config.ts'
import { Store, type TopicRow } from '../db.ts'
import { LineDecoder, encode, type ClientMsg, type DaemonMsg, type Hello } from '../ipc.ts'
import { cmdlineOf, isAlive } from '../proc.ts'
import { createBot } from '../tg.ts'
import { Streams } from './stream.ts'

export type ChatRef = { chatId: string; threadId?: number; isPrivate: boolean }

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
  lastChat: ChatRef | null
  turn: { start: number; replied: boolean } | null
  /** Notes prepended to the next inbound message (e.g. "you were stopped"). */
  notes: string[]
}

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
  }

  log(msg: string): void {
    process.stderr.write(`${new Date().toISOString()} ${msg}\n`)
  }

  // --- topics chat (forum supergroup) ---

  get topicsChatId(): string | null {
    return this.store.get('topics_chat_id')
  }

  /** True when only the owner can post in the topics group — safe to show permission buttons there. */
  topicsGroupIsStrict(): boolean {
    const chat = this.topicsChatId
    if (!chat) return false
    const a = loadAccess()
    const g = a.groups[chat]
    const o = owner(a)
    return g != null && o != null && g.allowFrom.length === 1 && g.allowFrom[0] === o
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

  /** Session that receives DMs: the one picked with /use, else the newest. */
  dmSession(): Session | null {
    const picked = this.store.get('dm_session')
    const list = this.activeSessions()
    const byPick = list.find(s => s.id === picked)
    if (byPick) return byPick
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
    this.send(session, { t: 'inbound', content, meta })
    session.lastActivity = Date.now()
    if (from) {
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
      lastChat: null,
      turn: null,
      notes: [],
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
    register(this.bot)
    let warned = false
    for (let attempt = 1; ; attempt++) {
      if (this.legacyConflict()) {
        if (!warned) this.log('official telegram plugin is polling the same token — waiting for it to stop')
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
        const delay = Math.min(1000 * attempt, 15_000)
        this.log(`${is409 ? '409 Conflict — another poller holds the token' : `polling error: ${err}`}; retry in ${delay / 1000}s`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
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
    const chat = this.topicsChatId
    return chat ? this.store.topicForProject(chat, s.projectKey) : null
  }

  socketExists(): boolean {
    return existsSync(SOCK_FILE)
  }
}
