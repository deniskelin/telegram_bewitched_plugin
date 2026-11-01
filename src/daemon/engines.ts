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

import { settings } from '../config.ts'
import type { Daemon } from './daemon.ts'
import type { LaunchOptions } from './launch.ts'
import { isQuestion } from './screen.ts'
import { projectTranscriptDir } from './transcript.ts'

export type EngineId = 'claude'

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
}

export const ENGINES: Record<EngineId, Engine> = { claude }

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
