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

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { execFile, execFileSync } from 'child_process'
import { PLUGIN_ROOT, settings } from '../config.ts'
import { INSTRUCTIONS } from '../client/instructions.ts'
import type { Daemon, Session } from './daemon.ts'
import type { LaunchOptions } from './launch.ts'
import { isQuestion } from './screen.ts'
import { projectTranscriptDir } from './transcript.ts'

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

function codexBin(): string | null {
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
    let cmd = `${codexBin() ?? 'codex'} --no-alt-screen -p ${CODEX_PROFILE}`
    if (o.model && MODEL.test(o.model)) cmd += ` -m ${o.model}`
    if (o.resume && /^[\w-]+$/.test(o.resume)) return `${codexBin() ?? 'codex'} resume ${o.resume} --no-alt-screen -p ${CODEX_PROFILE}${o.model && MODEL.test(o.model) ? ` -m ${o.model}` : ''}`
    return o.continue ? cmd.replace(' --no-alt-screen', ' resume --last --no-alt-screen') : cmd
  },
  isPromptReady: screen => /^\s*›/m.test(screen) && !isQuestion(screen),
  isModal: screen => isQuestion(screen),
  transcriptDir: () => join(CODEX_HOME, 'sessions'),
  exitCommand: '/quit',
  liveModelSwitch: false,
  available: () => codexBin() != null,
}

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
export function writeCodexProfile(bun = process.execPath): string | null {
  if (!codex.available()) return null
  const hook = `${bun} "${join(PLUGIN_ROOT, 'hooks', 'hook.ts')}"`
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']
  const lines = [
    '# Written by the telegram-bewitched daemon on every start; edits are lost.',
    `developer_instructions = ${tomlString(CODEX_PREFACE + INSTRUCTIONS)}`,
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
  mkdirSync(CODEX_HOME, { recursive: true })
  const file = join(CODEX_HOME, `${CODEX_PROFILE}.config.toml`)
  writeFileSync(file, lines.join('\n'), { mode: 0o600 })
  return file
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

/**
 * A message for a Codex session: codex queue into its thread (the id comes
 * with its first hook). Before that — or if queue fails — typed into its
 * window with the FR-14 checks, on one line (Enter would send a newline early).
 */
export async function codexDeliver(d: Daemon, s: Session, text: string): Promise<void> {
  const thread = s.claude.sessionId
  if (thread) {
    try {
      await d.codexQueue(thread, text)
      return
    } catch (err) {
      d.log(`codex queue for session ${s.id} failed, typing instead: ${err}`)
    }
  }
  if (!s.tmuxPane) throw new Error('no thread id yet and no tmux pane')
  await d.tmuxType(s.tmuxPane, text.replace(/\s*\n\s*/g, ' '))
}

export const ENGINES: Record<EngineId, Engine> = { claude, codex }

/** The engine by id; Claude Code for anything unknown (old records, no choice yet). */
export function engineOf(id?: string | null): Engine {
  return ENGINES[id as EngineId] ?? claude
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
  return { engine: c.engine, ...(c.model ? { model: c.model } : {}), ...o }
}
