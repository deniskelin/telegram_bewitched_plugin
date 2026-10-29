/**
 * Paths and settings shared by the daemon, the per-session MCP client, the
 * hook script and the CLI. Everything lives under one state directory so the
 * fork never touches the official plugin's ~/.claude/channels/telegram.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { randomBytes } from 'crypto'

export const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')

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
/** Local voice services: venvs, models, logs (bewitched voice install). */
export const VOICE_HOME = process.env.VOICE_HOME || join(STATE_DIR, 'voice')
export const TTS_CACHE_DIR = join(STATE_DIR, 'tts-cache')

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
  /** A session per allowlisted user for their DMs, in USERS_DIR/<user_id>. */
  get userSessions() { return process.env.USER_SESSIONS !== 'off' },
  get usersDir() { return resolve(process.env.USERS_DIR || join(homedir(), 'user')) },
  /** Close an idle user session after this many minutes (0 = never). */
  get userIdleMin() { return num('USER_IDLE_MIN', 0) },
  /** Close an idle project session after this many minutes (0 = never). */
  get projectIdleMin() { return num('PROJECT_IDLE_MIN', 0) },
  /** Wait this long after a session stops before reporting it (it may be restarted by hand). */
  get watchdogGraceSec() { return num('WATCHDOG_GRACE_SEC', 60) },
  /** A project topic without a running session: launch it, let the main session answer, or only queue. */
  get topicNoSession() { return str('TOPIC_NO_SESSION', 'launch', ['launch', 'main', 'queue'] as const) },
  /** Context window used for the fill percentage in session cards. */
  get contextWindow() { return num('CONTEXT_WINDOW', 1_000_000) },
  /** Offer /compact once the context is this full (percent, 0 = never). */
  get contextWarnPct() { return num('CONTEXT_WARN_PCT', 80) },
  /** /usage: ask Anthropic's undocumented OAuth endpoint for the subscription limits (off = local data only). */
  /** Pause after a key press in 👁 Экран before capturing the screen again. */
  get screenRedrawMs() { return num('SCREEN_REDRAW_MS', 700) },
  /** How often «✅ Подтвердить запуск» looks for the session to connect after the questions are answered. */
  get confirmPollMs() { return num('CONFIRM_POLL_MS', 1000) },
  /** Remind the owner when a launched session hasn't connected after this many seconds (again after 5×; 0 = never). */
  get launchRemindSec() { return num('LAUNCH_REMIND_SEC', 180) },
  get usageLimits() { return process.env.USAGE_LIMITS !== 'off' },
  /** Warn the owner when a limit crosses these percentages and when it resets ("off" = never). */
  get limitAlerts(): number[] {
    const v = process.env.LIMIT_ALERTS ?? '80,95'
    return v === 'off' ? [] : v.split(',').map(Number).filter(n => n > 0 && n <= 100).sort((a, b) => a - b)
  },
  /** Daily digest to the owner at this local time ("HH:MM"), or "off". */
  get digestAt() { const v = process.env.DIGEST_AT ?? '21:00'; return /^\d{1,2}:\d{2}$/.test(v) ? v.padStart(5, '0') : null },
  get limitCheckMin() { return num('LIMIT_CHECK_MIN', 10) },
  /** ⚡ Start the next 5-hour window right at its reset with a tiny request (on/off; the /usage button wins). */
  get limitWarmup() { return process.env.LIMIT_WARMUP === 'on' },
  /** The Claude Code binary for that request. */
  get claudeBin() { return process.env.CLAUDE_BIN || 'claude' },
  /** Tell the owner when another user took this much of the 5-hour window (percent, 0 = never). */
  get userShareAlert() { return num('USER_SHARE_ALERT', 40) },
  /** Messages without sound in this local time range ("23:00-08:00"), or "off". /menu → ⚙️ overrides it. */
  get quietHours() { return process.env.QUIET_HOURS || 'off' },
  /** Check the latest GitHub Actions run of each project session's branch every N minutes (gh; 0 = never). */
  get ciWatchMin() { return num('CI_WATCH_MIN', 5) },
  get usageApiUrl() { return process.env.USAGE_API_URL || 'https://api.anthropic.com/api/oauth/usage' },
  // --- voice: speech to text (incoming) ---
  /** "openai-compatible" (whisper.cpp, faster-whisper, OpenAI, Groq) or "off". */
  get sttProvider() { return str('STT_PROVIDER', 'off', ['off', 'openai-compatible'] as const) },
  /** Endpoints tried in order (comma-separated): the first is the main one, the rest are the fallback chain. */
  get sttUrls() { return (process.env.STT_URL ?? 'http://127.0.0.1:8178/v1/audio/transcriptions').split(',').map(s => s.trim()).filter(Boolean) },
  /** API keys aligned with STT_URL (comma-separated; one key applies to all). */
  get sttKeys() { return (process.env.STT_API_KEY ?? '').split(',').map(s => s.trim()) },
  get sttModel() { return process.env.STT_MODEL || 'whisper-1' },
  get sttLanguage() { return process.env.STT_LANGUAGE || '' },
  get sttMaxSec() { return num('STT_MAX_SEC', 600) },
  get sttVideo() { return process.env.STT_VIDEO === 'true' },
  /** The daemon runs voice/stt_server.py (faster-whisper) itself on the STT_URL port. */
  get sttLocal() { return process.env.STT_LOCAL === 'true' },
  get sttLocalModel() { return process.env.STT_LOCAL_MODEL || 'large-v3-turbo' },

  // --- voice: text to speech (outgoing) ---
  /** silero (local service), piper (binary), http (any OpenAI-compatible /v1/audio/speech), off. */
  get ttsProvider() { return str('TTS_PROVIDER', 'off', ['off', 'silero', 'piper', 'http'] as const) },
  get ttsFallback() { return str('TTS_FALLBACK', 'off', ['off', 'silero', 'piper', 'http'] as const) },
  get ttsVoice() { return process.env.TTS_VOICE || 'xenia' },
  get ttsUrl() { return process.env.TTS_URL || '' },
  get ttsApiKey() { return process.env.TTS_API_KEY || '' },
  get ttsModel() { return process.env.TTS_MODEL || 'tts-1' },
  get ttsPort() { return num('TTS_PORT', 8179) },
  get ttsSampleRate() { return num('TTS_SAMPLE_RATE', 48000) },
  get ttsIdleMin() { return num('TTS_IDLE_MIN', 30) },
  get piperBin() { return process.env.PIPER_BIN || 'piper' },
  get piperModel() { return process.env.PIPER_MODEL || '' },
  get voiceMaxChars() { return num('VOICE_MAX_CHARS', 1500) },
  get voiceWithText() { return str('VOICE_WITH_TEXT', 'caption', ['caption', 'message', 'none'] as const) },
  get ttsCacheMb() { return num('TTS_CACHE_MB', 200) },
  get ffmpegBin() { return process.env.FFMPEG_BIN || 'ffmpeg' },

  get mainDir() { return resolve(process.env.MAIN_DIR || homedir()) },
  get tmuxSession() { return process.env.TMUX_SESSION || 'claude' },
  /** JOURNAL_CHAT_ID: a group for the daemon's notices and events instead of the owner's DM (see journal.ts). */
  get journalChatId() { const v = process.env.JOURNAL_CHAT_ID?.trim(); return v && /^-\d+$/.test(v) ? v : null },
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
