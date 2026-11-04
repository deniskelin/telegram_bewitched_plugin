/**
 * Preloaded before every test file: point all state at a temp dir so tests
 * can never touch ~/.claude, and talk to a fake Bot API only.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FakeTelegram } from './fake-telegram.ts'

const root = mkdtempSync(join(tmpdir(), 'bewitched-test-'))
const stateDir = join(root, 'state')
mkdirSync(stateDir, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
process.env.CODEX_HOME = join(root, 'codex')
process.env.TELEGRAM_BEWITCHED_STATE_DIR = stateDir
process.env.TELEGRAM_BOT_TOKEN = '123:TEST'
process.env.BEWITCHED_HTTP_PORT = String(20000 + Math.floor(Math.random() * 20000))
process.env.GROUP_EDIT_INTERVAL_MS = '50'
process.env.STREAM_MIN_INTERVAL_MS = '50'
process.env.NOTIFY_LONG_SEC = '0'
process.env.PROJECTS_DIR = join(root, 'projects')
process.env.USERS_DIR = join(root, 'user')
// A project topic without a session queues its messages (no tmux in tests); the session-types tests switch to launch.
process.env.TOPIC_NO_SESSION = 'queue'
process.env.WATCHDOG_GRACE_SEC = '3600'
process.env.SCREEN_REDRAW_MS = '0'
process.env.HANDOFF_SUMMARY_SEC = '0'
// No probe of the real Codex sandbox in tests.
process.env.CODEX_SANDBOX = 'workspace-write'
// Screens as HTML, so tests read their text; the FR-11 test switches rich screens on.
process.env.RICH_SCREENS = 'off'
// F01: a tmux the tests cannot reach the user's server with: whatever bypasses the daemon's adapters
// (d.tmuxKeys, d.tmuxCapture…) finds this one — it fails and writes down what it was asked.
const fakeBin = join(root, 'bin')
mkdirSync(fakeBin, { recursive: true })
export const realTmuxLog = join(root, 'tmux-calls.log')
writeFileSync(join(fakeBin, 'tmux'), `#!/bin/sh\necho "$*" >> '${realTmuxLog}'\necho 'tmux is disabled in tests' >&2\nexit 1\n`, { mode: 0o755 })
process.env.PATH = `${fakeBin}:${process.env.PATH}`
delete process.env.TMUX
delete process.env.TMUX_PANE
writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111'], groups: {}, pending: {} }))

export const fakeTelegram = new FakeTelegram()
process.env.TELEGRAM_API_ROOT = fakeTelegram.apiRoot
