#!/usr/bin/env bun
/**
 * Daemon entry point. Started on demand by the first session's MCP client
 * (detached), or by hand: `bewitched daemon start`.
 */

import { linkSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { LOCK_FILE, SOCK_FILE, ensureStateDir, loadEnv, migrateLegacy, settings } from '../config.ts'
import { cmdlineOf, isAlive } from '../proc.ts'
import { startQuestionExpiry } from './buttons.ts'
import { Daemon } from './daemon.ts'
import { startHttp } from './http.ts'
import { handlePermissionRequest, registerInbound } from './inbound.ts'
import { handleCall } from './tools.ts'
import { registerLaunchCommands, startIdleCloser } from './launch.ts'
import { startDigest, startLimitWatch } from './usage.ts'
import { startReminders } from './reminders.ts'
import { startReports } from './reports.ts'
import { startAllowlistWatch } from './invite.ts'
import { voiceServices } from '../voice/service.ts'
import { setLocalSttStarter } from '../voice/stt.ts'
import { setSileroStarter } from '../voice/tts.ts'
import { reportRestart } from './server.ts'
import { startCiWatch } from './events.ts'
import { inSession } from './lang.ts'
import { LANGS, t, withLang } from '../i18n/index.ts'
import { onSessionGone, onSessionRegistered, registerTopicCommands, scheduleDashboard } from './topics.ts'

function log(m: string): void {
  process.stderr.write(`${new Date().toISOString()} ${m}\n`)
}

/**
 * One daemon per state dir. The pid file appears atomically, already holding
 * the pid (written to a temp file, then hard-linked into place: link fails if
 * the file exists), so a racing starter never sees it empty. A stale file
 * (dead or recycled pid) is taken over; a fresh one never is.
 */
function acquireLock(): boolean {
  const tmp = `${LOCK_FILE}.${process.pid}`
  writeFileSync(tmp, String(process.pid), { mode: 0o600 })
  try {
    for (let i = 0; i < 3; i++) {
      try {
        linkSync(tmp, LOCK_FILE)
        return true
      } catch {}
      let raw = ''
      let age = 0
      try {
        raw = readFileSync(LOCK_FILE, 'utf8')
        age = Date.now() - statSync(LOCK_FILE).mtimeMs
      } catch {
        continue // removed meanwhile: try again
      }
      const pid = parseInt(raw, 10)
      const alive = pid > 1 && isAlive(pid) && cmdlineOf(pid).join(' ').includes('daemon/main.ts')
      if (alive || (Number.isNaN(pid) && age < 10_000)) return false
      // Still the same stale file? (Another starter may have replaced it.)
      try {
        if (readFileSync(LOCK_FILE, 'utf8') === raw) rmSync(LOCK_FILE, { force: true })
      } catch {}
    }
    return false
  } finally {
    rmSync(tmp, { force: true })
  }
}

ensureStateDir()
migrateLegacy(log)
loadEnv()

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  log('TELEGRAM_BOT_TOKEN required — set it via /telegram-bewitched:configure')
  process.exit(1)
}
if (!acquireLock()) {
  log('daemon already running')
  process.exit(0)
}

process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', err => log(`uncaught exception: ${err}`))

const d = new Daemon(TOKEN)
d.onSessionRegistered = s => onSessionRegistered(d, s)
d.onSessionGone = s => onSessionGone(d, s)
d.onSessionsChanged = () => scheduleDashboard(d)
d.handleCall = (s, name, args) => inSession(d, s, () => handleCall(d, s, name, args))
d.handlePermissionRequest = (s, p) => handlePermissionRequest(d, s, p)

let stopping = false
function shutdown(code = 0): void {
  if (stopping) return
  stopping = true
  log('shutting down')
  try {
    if (parseInt(readFileSync(LOCK_FILE, 'utf8'), 10) === process.pid) rmSync(LOCK_FILE, { force: true })
  } catch {}
  rmSync(SOCK_FILE, { force: true })
  voice.stt.stop()
  voice.silero.stop()
  setTimeout(() => process.exit(code), 2000)
  void Promise.resolve(d.bot.stop()).finally(() => process.exit(code))
}
process.on('SIGTERM', () => shutdown())
process.on('SIGINT', () => shutdown())

d.pruneGreeted()
d.listen()
startHttp(d)
startQuestionExpiry(d)
d.startIdleWatch(() => shutdown())
startIdleCloser(d)
startLimitWatch(d)
startDigest(d)
startReminders(d)
startCiWatch(d)
startReports(d)
startAllowlistWatch(d)
const voice = voiceServices(log)
setLocalSttStarter(() => voice.stt.ensure())
setSileroStarter(() => voice.silero.ensure())
// Warm the recognizer up: the first voice message shouldn't wait for the model.
if (settings.sttLocal && settings.sttProvider !== 'off' && voice.stt.installed()) void voice.stt.ensure().catch(err => log(`stt: ${err}`))
setInterval(() => d.store.pruneHistory(settings.historyMaxDays), 6 * 3600_000).unref()
log(`daemon pid=${process.pid} listening on ${SOCK_FILE}, http 127.0.0.1:${settings.httpPort}`)

void d.startPolling(bot => {
  registerTopicCommands(d, bot)
  registerLaunchCommands(d, bot)
  registerInbound(d, bot, TOKEN)
  // A short menu: everything else is a button in /menu (old commands still work).
  // One list per language (Telegram shows the one for the user's app language), plus the default.
  const commands = () => [
    { command: 'menu', description: t('Меню: сессии, статистика, люди, настройки') },
    { command: 'sessions', description: t('Сессии') },
    { command: 'usage', description: t('Лимиты подписки и расход') },
    { command: 'help', description: t('Помощь') },
  ]
  void bot.api.setMyCommands(commands(), { scope: { type: 'all_private_chats' } }).catch(() => {})
  for (const l of LANGS) {
    void withLang(l, () => bot.api.setMyCommands(commands(), { scope: { type: 'all_private_chats' }, language_code: l })).catch(() => {})
  }
  void reportRestart(d).catch(err => log(`restart report: ${err}`))
}).catch(err => {
  log(`startup failed: ${err}`)
  shutdown(1)
})
