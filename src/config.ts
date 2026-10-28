/**
 * Paths and settings shared by the daemon, the per-session MCP client, the
 * hook script and the CLI. Everything lives under one state directory so the
 * fork never touches the official plugin's ~/.claude/channels/telegram.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { randomBytes } from 'crypto'

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')

export const STATE_DIR = process.env.TELEGRAM_BEWITCHED_STATE_DIR
  ?? join(CONFIG_DIR, 'channels', 'telegram-bewitched')
export const LEGACY_STATE_DIR = join(CONFIG_DIR, 'channels', 'telegram')

export const ENV_FILE = join(STATE_DIR, '.env')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const MEMORY_DIR = join(STATE_DIR, 'memory')
export const LOG_DIR = join(STATE_DIR, 'logs')
export const DB_FILE = join(STATE_DIR, 'history.db')
export const SOCK_FILE = join(STATE_DIR, 'daemon.sock')
export const LOCK_FILE = join(STATE_DIR, 'daemon.pid')
export const HTTP_TOKEN_FILE = join(STATE_DIR, 'http.token')
export const DAEMON_LOG = join(LOG_DIR, 'daemon.log')

/** Plugin root — this file is <root>/src/config.ts. */
export const PLUGIN_ROOT = join(import.meta.dir, '..')

export const PROTOCOL_VERSION = 1

export function ensureStateDir(): void {
  for (const d of [STATE_DIR, INBOX_DIR, MEMORY_DIR, LOG_DIR]) mkdirSync(d, { recursive: true, mode: 0o700 })
}

/**
 * First run: copy the bot token and access list from the official plugin so
 * pairing doesn't have to be redone. The legacy files are left in place.
 */
export function migrateLegacy(log: (m: string) => void = () => {}): void {
  ensureStateDir()
  for (const f of ['.env', 'access.json']) {
    const src = join(LEGACY_STATE_DIR, f)
    const dst = join(STATE_DIR, f)
    if (!existsSync(dst) && existsSync(src)) {
      copyFileSync(src, dst)
      chmodSync(dst, 0o600)
      log(`migrated ${f} from ${LEGACY_STATE_DIR}`)
    }
  }
}

/** Load STATE_DIR/.env into process.env. Real env wins. */
export function loadEnv(): void {
  try {
    chmodSync(ENV_FILE, 0o600)
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
}

function num(name: string, def: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] != null ? v : def
}

function str<T extends string>(name: string, def: T, allowed?: readonly T[]): T {
  const v = process.env[name] as T | undefined
  if (v == null || v === '') return def
  return allowed && !allowed.includes(v) ? def : v
}

/** Settings read lazily so tests can tweak process.env before use. */
export const settings = {
  get httpPort() { return num('BEWITCHED_HTTP_PORT', 8797) },
  get idleExitMin() { return num('DAEMON_IDLE_EXIT_MIN', 0) },
  get topicMode() { return str('TOPIC_MODE', 'project', ['project', 'session', 'off'] as const) },
  get permissionsTo() { return str('PERMISSIONS_TO', 'topic', ['topic', 'dm', 'both'] as const) },
  get stopMode() { return str('STOP_MODE', 'interrupt', ['interrupt', 'notify', 'off'] as const) },
  get progressFinal() { return str('PROGRESS_FINAL', 'delete', ['delete', 'replace', 'keep'] as const) },
  get streamMinIntervalMs() { return num('STREAM_MIN_INTERVAL_MS', 700) },
  get groupEditIntervalMs() { return num('GROUP_EDIT_INTERVAL_MS', 3000) },
  get notifyLongSec() { return num('NOTIFY_LONG_SEC', 60) },
  get pendingTtlH() { return num('PENDING_TTL_H', 72) },
  get historyMaxDays() { return num('HISTORY_MAX_DAYS', 90) },
  get resumeLastN() { return num('RESUME_LAST_N', 10) },
  get notifyRatePerMin() { return num('NOTIFY_RATE_PER_MIN', 20) },
  get passiveTools() { return process.env.PASSIVE_TOOLS === 'true' },
  get apiRoot() { return process.env.TELEGRAM_API_ROOT || undefined },
  /** Manual topic in the group → project dir + new session. */
  get topicProjects() { return str('TOPIC_PROJECTS', 'auto', ['auto', 'ask', 'off'] as const) },
  get projectsDir() { return process.env.PROJECTS_DIR || join(homedir(), 'projects') },
  /** Folder of the main session: DMs, General and topics without a session of their own. */
  get mainDir() { return resolve(process.env.MAIN_DIR || homedir()) },
  get tmuxSession() { return process.env.TMUX_SESSION || 'claude' },
  get launchCmd() { return process.env.CLAUDE_LAUNCH_CMD || 'claude --dangerously-load-development-channels plugin:telegram-bewitched@bewitched' },
}

/** Bearer token for the local HTTP endpoint (hooks, notify). Created on first use. */
export function httpToken(): string {
  try {
    return readFileSync(HTTP_TOKEN_FILE, 'utf8').trim()
  } catch {
    ensureStateDir()
    const t = randomBytes(24).toString('hex')
    writeFileSync(HTTP_TOKEN_FILE, t, { mode: 0o600 })
    return t
  }
}
