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
process.env.TELEGRAM_BEWITCHED_STATE_DIR = stateDir
process.env.TELEGRAM_BOT_TOKEN = '123:TEST'
process.env.BEWITCHED_HTTP_PORT = String(20000 + Math.floor(Math.random() * 20000))
process.env.GROUP_EDIT_INTERVAL_MS = '50'
process.env.STREAM_MIN_INTERVAL_MS = '50'
process.env.NOTIFY_LONG_SEC = '0'
writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111'], groups: {}, pending: {} }))

export const fakeTelegram = new FakeTelegram()
process.env.TELEGRAM_API_ROOT = fakeTelegram.apiRoot
