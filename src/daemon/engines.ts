/**
 * FR-15: the engine layer. An engine is an agent CLI the daemon runs in tmux
 * for a session. Claude Code talks to the daemon over the channel (MCP in,
 * hooks for progress, `reply` out); engines without a channel (Codex, FR-16)
 * will be typed into (tmuxType, FR-14) and read from their transcripts.
 * Everything above an engine — streaming, ⏹, the journal, the watchdogs,
 * rich screens — works with sessions, not with a particular CLI.
 *
 * A project remembers its engine and model (engine:<project key> in the
 * store): every launch of its session — from a topic, 🚀, ♻️, a user's DM —
 * starts with them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { execFile, execFileSync } from 'child_process'
import { PLUGIN_ROOT, settings } from '../config.ts'
import { INSTRUCTIONS } from '../client/instructions.ts'
import type { Daemon, Session } from './daemon.ts'
import type { LaunchOptions } from './launch.ts'
import { isQuestion, screenView } from './screen.ts'
import { inChat } from './lang.ts'
import { t } from '../i18n/index.ts'
import type { ChatRef } from './daemon.ts'
import { projectTranscriptDir } from './transcript.ts'
import { launchPrompt } from './promptmode.ts'

export type EngineId = 'claude' | 'codex'

export type EngineModel = { alias: string; id: string }

export type Engine = {
  id: EngineId
  name: string
  /** channel: messages in through MCP, progress from hooks; tui: typed in, read from the transcript. */
  delivery: 'channel' | 'tui'
  models: EngineModel[]
  /** The shell command that starts it in tmux; never built from chat input. */
  launchCommand(o: LaunchOptions): string
  /** The input line is on the screen: the TUI takes typed text. */
  isPromptReady(screen: string): boolean
  /** A question (a menu, a confirmation) holds the input. */
  isModal(screen: string): boolean
  /** Where its conversations of a folder are kept (for /resume, the turn cost). */
  transcriptDir(cwd: string): string
  /** What ends it when typed (idle suspension, ♻️). */
  exitCommand: string
  /** /model <id> switches the running session; otherwise a model applies from the next launch. */
  liveModelSwitch: boolean
  /** Installed on this machine. */
  available(): boolean
}

const NAME = /^[\p{L}\p{N}._-]+$/u
const SAFE_PATH = /^[\w./-]+$/
const MODEL = /^[\w.-]+$/

/** Claude Code: CLAUDE_LAUNCH_CMD plus -n <name> (a slug), --model <id>, --resume <id> (ids are checked) or --continue. */
export const claude: Engine = {
  id: 'claude',
  name: 'Claude Code',
  delivery: 'channel',
  models: [
    { alias: 'opus', id: 'claude-opus-5-5' },
    { alias: 'sonnet', id: 'claude-sonnet-5-5' },
    { alias: 'haiku', id: 'claude-haiku-5-5' },
    { alias: 'fable', id: 'claude-fable-5-1' },
  ],
  launchCommand(o) {
    let cmd = settings.launchCmd
    if (o.name && NAME.test(o.name)) cmd += ` -n ${o.name}`
    if (o.model && MODEL.test(o.model)) cmd += ` --model ${o.model}`
    // FR-20: the prompt is read from the daemon's file by the shell, never put on the command line as text.
    if (o.prompt && SAFE_PATH.test(o.prompt.file)) cmd += ` --append-system-prompt "$(cat '${o.prompt.file}')"`
    const tools = (o.prompt?.disallowed ?? []).filter(x => /^\w+$/.test(x))
    if (tools.length) cmd += ` --disallowedTools ${tools.join(',')}`
    if (o.resume && /^[\w-]+$/.test(o.resume)) return `${cmd} --resume ${o.resume}`
    return o.continue ? `${cmd} --continue` : cmd
  },
  isPromptReady: screen => /^\s*❯/m.test(screen) && !isQuestion(screen),
  isModal: screen => isQuestion(screen),
  transcriptDir: cwd => projectTranscriptDir(cwd),
  exitCommand: '/exit',
  liveModelSwitch: true,
  available: () => true,
}

// --------------------------------------------------------------------------
// Codex CLI (FR-16)
// --------------------------------------------------------------------------

/** Codex's own profile for daemon-launched sessions: $CODEX_HOME/bewitched.config.toml (written by writeCodexProfile). */
export const CODEX_PROFILE = 'bewitched'
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex')

export function codexBin(): string | null {
  const own = process.env.CODEX_BIN ?? join(homedir(), '.local', 'bin', 'codex')
  if (existsSync(own)) return own
  try {
    return execFileSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8', timeout: 2000 }).trim() || null
  } catch {
    return null
  }
}

/**
 * Codex CLI: started in tmux with the bewitched profile — our MCP server (reply,
 * buttons, files), our hooks (Codex's are Claude-compatible: progress, Stop
 * with the last message) and the channel instructions. Messages go in with
 * `codex queue` (codexDeliver), not through a channel. Its questions mark the
 * choice with › rather than ❯.
 */
export const codex: Engine = {
  id: 'codex',
  name: 'Codex',
  delivery: 'tui',
  models: [
    { alias: 'sol', id: 'gpt-6.1-sol' },
    { alias: 'terra', id: 'gpt-6.1-terra' },
    { alias: 'astra', id: 'gpt-6-astra' },
    { alias: 'luna', id: 'gpt-6-luna' },
  ],
  launchCommand(o) {
    // FR-20: a prompt mode runs with a profile of its own (the mode's text in the instructions, a read-only sandbox).
    const profile = o.prompt ? writeCodexModeProfile(o.prompt) ?? CODEX_PROFILE : CODEX_PROFILE
    let cmd = `${codexBin() ?? 'codex'} --no-alt-screen -p ${profile}`
    if (o.model && MODEL.test(o.model)) cmd += ` -m ${o.model}`
    if (o.resume && /^[\w-]+$/.test(o.resume)) return `${codexBin() ?? 'codex'} resume ${o.resume} --no-alt-screen -p ${profile}${o.model && MODEL.test(o.model) ? ` -m ${o.model}` : ''}`
    return o.continue ? cmd.replace(' --no-alt-screen', ' resume --last --no-alt-screen') : cmd
  },
  isPromptReady: screen => /^\s*›/m.test(screen) && !isQuestion(screen),
  isModal: screen => isQuestion(screen),
  transcriptDir: () => join(CODEX_HOME, 'sessions'),
  exitCommand: '/quit',
  liveModelSwitch: false,
  available: () => codexBin() != null,
}

/** A POSIX shell single-quoted word. */
const shQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`

/** TOML basic string. */
const tomlString = (v: string) => JSON.stringify(v)

const CODEX_PREFACE = [
  'You run inside the telegram-bewitched bridge: the user writes from Telegram. Their messages arrive as user turns wrapped in <channel source="telegram-bewitched" …>…</channel>.',
  'Answer only with the tools of the telegram-bewitched MCP server (reply, ask_user, …): pass text explicitly — never use_last_message, there is no live streaming here. Plain transcript output never reaches the user.',
  '',
].join('\n')

/**
 * $CODEX_HOME/bewitched.config.toml: the MCP server (the same thin client as
 * Claude's, started by bun), the hooks (hooks/hook.ts posts to the daemon) and
 * the channel instructions. Rewritten on every daemon start — paths follow the
 * plugin. Codex asks once to trust the hooks; the answer is kept.
 */
export function writeCodexProfile(bun = process.execPath, mode?: { name: string; text: string; readOnly: boolean }): string | null {
  if (!codex.available()) return null
  mkdirSync(CODEX_HOME, { recursive: true })
  // FR-19: Codex trusts a hook by a hash of its definition. The definition is a fixed wrapper path, so moving the
  // plugin or updating bun changes only the wrapper's body — Codex does not ask to trust the hooks again.
  const wrapper = join(CODEX_HOME, 'bewitched-hook.sh')
  writeFileSync(wrapper, `#!/bin/sh\n# Written by the telegram-bewitched daemon on every start.\nexec ${shQuote(bun)} ${shQuote(join(PLUGIN_ROOT, 'hooks', 'hook.ts'))}\n`, { mode: 0o700 })
  const hook = `sh ${shQuote(wrapper)}`
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']
  const lines = [
    '# Written by the telegram-bewitched daemon on every start; edits are lost.',
    `developer_instructions = ${tomlString(CODEX_PREFACE + INSTRUCTIONS + (mode ? `\n\n${mode.text}` : ''))}`,
    ...(mode?.readOnly ? ['sandbox_mode = "read-only"'] : []),
    // One project memory for both engines: without an AGENTS.md Codex reads the project's CLAUDE.md.
    'project_doc_fallback_filenames = ["CLAUDE.md"]',
    '',
    '[mcp_servers.telegram-bewitched]',
    `command = ${tomlString(bun)}`,
    `args = ${JSON.stringify(['run', '--cwd', PLUGIN_ROOT, '--shell=bun', '--silent', 'start'])}`,
    'startup_timeout_sec = 60',
    'tool_timeout_sec = 600',
    // Our own tools (reply, ask_user…) run without «Allow the MCP server to run tool?» — as on Claude's channel.
    'default_tools_approval_mode = "approve"',
    '',
    ...events.flatMap(e => [`[[hooks.${e}]]`, ...(e === 'PreToolUse' || e === 'PostToolUse' ? ['matcher = "*"'] : []), `[[hooks.${e}.hooks]]`, 'type = "command"', `command = ${tomlString(hook)}`, 'timeout = 3', '']),
  ]
  const file = join(CODEX_HOME, `${mode?.name ?? CODEX_PROFILE}.config.toml`)
  writeFileSync(file, lines.join('\n'), { mode: 0o600 })
  return file
}

/** FR-20: the profile of a prompt mode, bewitched-<key>; null when Codex is missing. */
export function writeCodexModeProfile(p: NonNullable<LaunchOptions['prompt']>): string | null {
  let text = ''
  try { text = readFileSync(p.file, 'utf8').trim() } catch { return null }
  const name = `${CODEX_PROFILE}-${p.key}`
  return writeCodexProfile(process.execPath, { name, text, readOnly: p.readOnly }) ? name : null
}

/** A Telegram message as the model sees it on the channel: <channel source=… attrs>content</channel>. */
export function channelText(content: string, meta: Record<string, string>): string {
  const attrs = Object.entries(meta)
    .filter(([k, v]) => k !== 'stream_answer' && /^\w+$/.test(k) && v != null)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;').replace(/\n/g, ' ')}"`)
  return `<channel source="telegram-bewitched" ${attrs.join(' ')}>\n${content}\n</channel>`
}

/** Hand a message to a running Codex session: codex queue into its thread. */
export function codexQueue(thread: string, text: string): Promise<void> {
  const bin = codexBin()
  if (!bin) return Promise.reject(new Error('codex not found'))
  return new Promise((res, rej) => {
    execFile(bin, ['queue', '--thread', thread, '--message', text], { timeout: 30_000 }, err => (err ? rej(err) : res()))
  })
}

/** How long a fresh Codex gets to show its input line before a message is pasted anyway. Replaced in tests. */
export const codexTiming = { readyMs: 30_000, pollMs: 500 }

/** Deliveries per session, one after another: two pastes at once would mix in the input line. */
const codexChains = new Map<string, Promise<void>>()

/**
 * A message for a Codex session: codex queue into its thread (the id comes
 * with its first hook). Before that — or if queue fails — pasted into its
 * window (one bracketed paste: newlines stay, a long text shows as «[Pasted
 * Content N chars]») once its input line is up, with the FR-14 checks.
 * Every step goes to the log: how it went in, how long, how it ended.
 */
export function codexDeliver(d: Daemon, s: Session, text: string): Promise<void> {
  const prev = codexChains.get(s.id) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(() => codexDeliverNow(d, s, text))
  codexChains.set(s.id, next)
  void next.catch(() => {}).finally(() => { if (codexChains.get(s.id) === next) codexChains.delete(s.id) })
  return next
}

async function codexDeliverNow(d: Daemon, s: Session, text: string): Promise<void> {
  const started = Date.now()
  const chars = [...text].length
  const thread = s.claude.sessionId
  if (thread) {
    try {
      await d.codexQueue(thread, text)
      d.log(`codex ${s.id}: queued ${chars} chars into thread ${thread} (${Date.now() - started} ms)`)
      return
    } catch (err) {
      d.log(`codex ${s.id}: queue into thread ${thread} failed, pasting instead: ${err}`)
    }
  }
  if (!s.tmuxPane) throw new Error('no thread id yet and no tmux pane')
  // A fresh Codex connects (its MCP server starts) before its input line is drawn.
  let screen = ''
  const until = Date.now() + codexTiming.readyMs
  while (Date.now() < until) {
    screen = (await d.tmuxCapture(s.tmuxPane)) ?? ''
    if (codex.isPromptReady(screen) || codex.isModal(screen)) break
    await Bun.sleep(codexTiming.pollMs)
  }
  const waited = Date.now() - started
  if (!codex.isPromptReady(screen)) d.log(`codex ${s.id}: input line not ready after ${waited} ms, pasting anyway; screen:\n${tail(screen)}`)
  try {
    await d.tmuxType(s.tmuxPane, text, { paste: true })
  } catch (err) {
    const shot = err instanceof Error && 'screen' in err ? String((err as { screen: string }).screen) : ((await d.tmuxCapture(s.tmuxPane)) ?? '')
    d.log(`codex ${s.id}: paste of ${chars} chars not taken (${err instanceof Error ? err.message : err}); screen:\n${tail(shot)}`)
    throw err
  }
  d.log(`codex ${s.id}: pasted ${chars} chars into ${s.tmuxPane}${thread ? '' : ' (no thread id yet)'} (waited ${waited} ms, total ${Date.now() - started} ms)`)
}

/** FR-16: messages that came in during a Codex turn, by session. */
const codexHeld = new Map<string, { texts: string[]; from?: ChatRef }>()

/** Longest a message waits for the end of a turn: a lost Stop hook must not keep it forever. */
export const CODEX_HOLD_MAX_MS = 10 * 60_000

/**
 * Hold a message for after the turn (the turn really runs: a hook came since
 * it began). False when nothing should be held (no chat to tell).
 */
export function holdForCodex(d: Daemon, s: Session, text: string, from?: ChatRef): boolean {
  if (!from) return false
  const first = !codexHeld.has(s.id)
  const h = codexHeld.get(s.id) ?? { texts: [], from }
  h.texts.push(text)
  h.from = from
  codexHeld.set(s.id, h)
  if (first) setTimeout(() => { if (codexHeld.get(s.id) === h) codexFlushHeld(d, s) }, CODEX_HOLD_MAX_MS).unref?.()
  return true
}

/** Messages held for a session: how many. */
export function codexHeldCount(s: Session): number {
  return codexHeld.get(s.id)?.texts.length ?? 0
}

/** The turn ended: what came in meanwhile goes in as one message. Text for the model, not translated. */
export function codexFlushHeld(d: Daemon, s: Session): void {
  const h = codexHeld.get(s.id)
  if (!h) return
  codexHeld.delete(s.id)
  const text = h.texts.length === 1
    ? h.texts[0]
    : `While you were working, ${h.texts.length} messages came in. Answer them together, in order:\n\n${h.texts.join('\n\n')}` // i18n-ignore
  d.log(`codex ${s.id}: ${h.texts.length} held message(s) delivered after the turn`)
  void codexDeliver(d, s, text).catch(err => codexUndelivered(d, s, err, h.from))
}

/** The session is gone: its held messages, if any, are handed back (to the pending queue by the caller). */
export function codexTakeHeld(s: Session): string[] {
  const h = codexHeld.get(s.id)
  codexHeld.delete(s.id)
  return h?.texts ?? []
}

/**
 * A message Codex did not take: the chat no longer shows «⏳ Работаю…» for a
 * turn that never began, and gets the window's screen with keys — the text
 * may be in the input line waiting for Enter, or a question holds it.
 */
export async function codexUndelivered(d: Daemon, s: Session, err: unknown, from?: ChatRef): Promise<void> {
  d.log(`deliver to codex session ${s.id} failed: ${err instanceof Error ? err.message : err}`)
  if (!from) return
  if (s.turn && !s.turn.replied) {
    s.turn = null
    s.status = 'idle'
    d.streams.close(s, 'gone')
    d.onSessionsChanged()
  }
  const pane = s.tmuxPane && /^%\d+$/.test(s.tmuxPane) ? s.tmuxPane : null
  await inChat(d, from.chatId, from.threadId, async () => {
    const note = t('⚠️ Сообщение не дошло до Codex: окно не приняло ввод. Если на экране ваш текст — нажмите ⏎ Enter; если вопрос — ответьте клавишами и отправьте сообщение ещё раз.')
    const v = pane ? await screenView(d, `p${pane.slice(1)}`, false, note) : null
    await d.bot.api.sendMessage(from.chatId, v?.text ?? note, {
      parse_mode: 'HTML',
      ...(from.threadId != null ? { message_thread_id: from.threadId } : {}),
      ...(v ? { reply_markup: v.kb } : {}),
    })
  }).catch(e => d.log(`codex undelivered notice failed: ${e}`))
}

/** The last non-empty lines of a screen, for the log. */
function tail(screen: string, n = 8): string {
  return screen.split('\n').filter(l => l.trim()).slice(-n).map(l => `  | ${l.trimEnd()}`).join('\n')
}

export const ENGINES: Record<EngineId, Engine> = { claude, codex }

/** The engine by id; Claude Code for anything unknown (old records, no choice yet). */
export function engineOf(id?: string | null): Engine {
  return ENGINES[id as EngineId] ?? claude
}

/**
 * The last conversation of a folder on an engine (Claude's session id, Codex's
 * thread id), from the hooks: a restart, a switch back from the other engine
 * or an idle wake-up continues it rather than starting afresh.
 */
export function rememberConversation(d: Daemon, s: Session, id: string): void {
  const key = `last_conv:${s.engine}:${s.cwd}`
  if (d.store.get(key) === id) return
  d.store.set(key, id)
  // FR-20: which conversation the folder had when — a reply to an old message can go back to its conversation.
  const hist = conversationHistory(d, s.cwd)
  hist.push({ id, engine: s.engine, at: Date.now() })
  d.store.set(`conv_hist:${s.cwd}`, JSON.stringify(hist.slice(-50)))
  d.log(`session ${s.id} (${s.engine}) conversation ${id} in ${s.cwd}`)
}

export type ConvMark = { id: string; engine: EngineId; at: number }

/** The conversations a folder had, oldest first, with when each became current. */
export function conversationHistory(d: Daemon, dir: string): ConvMark[] {
  try {
    const v = JSON.parse(d.store.get(`conv_hist:${dir}`) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** The conversation that was current in dir at time `at` (ms), or null when none is known. */
export function conversationAt(d: Daemon, dir: string, at: number): ConvMark | null {
  let found: ConvMark | null = null
  for (const c of conversationHistory(d, dir)) if (c.at <= at) found = c
  return found
}

export function lastConversation(d: Daemon, engine: EngineId, dir: string): string | null {
  return d.store.get(`last_conv:${engine}:${dir}`) ?? null
}

export type EngineChoice = { engine: EngineId; model?: string }

/** The engine and model a project's session is started with. */
export function projectEngine(d: Daemon, projectKey: string): EngineChoice {
  try {
    const c = JSON.parse(d.store.get(`engine:${projectKey}`) ?? '') as Partial<EngineChoice>
    const engine = engineOf(c.engine)
    const model = engine.models.some(m => m.id === c.model) ? c.model : undefined
    return { engine: engine.id, ...(model ? { model } : {}) }
  } catch {
    return { engine: 'claude' }
  }
}

/** Remember a project's engine and model; no model — the CLI's own default. */
export function setProjectEngine(d: Daemon, projectKey: string, c: EngineChoice): void {
  d.store.set(`engine:${projectKey}`, JSON.stringify(c.model ? c : { engine: c.engine }))
}

/** Launch options with the project's engine and model, unless the caller chose them. */
export function withProjectEngine(d: Daemon, dir: string, o: LaunchOptions = {}): LaunchOptions {
  const c = projectEngine(d, dir)
  const prompt = launchPrompt(d, dir)
  return { engine: c.engine, ...(c.model ? { model: c.model } : {}), ...(prompt ? { prompt } : {}), ...o }
}
