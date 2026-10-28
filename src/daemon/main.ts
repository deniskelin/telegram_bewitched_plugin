#!/usr/bin/env bun
/**
 * Daemon entry point. Started on demand by the first session's MCP client
 * (detached), or by hand: `bewitched daemon start`.
 */

import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'fs'
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
import { onSessionGone, onSessionRegistered, registerTopicCommands, scheduleDashboard } from './topics.ts'

function log(m: string): void {
  process.stderr.write(`${new Date().toISOString()} ${m}\n`)
}

/** One daemon per state dir. A stale pid file (dead or recycled pid) is taken over. */
function acquireLock(): boolean {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(LOCK_FILE, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch {
      const pid = parseInt(readFileSync(LOCK_FILE, 'utf8'), 10)
      if (pid > 1 && pid !== process.pid && isAlive(pid) && cmdlineOf(pid).join(' ').includes('daemon/main.ts')) return false
      rmSync(LOCK_FILE, { force: true })
    }
  }
  return false
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
d.handleCall = (s, name, args) => handleCall(d, s, name, args)
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
startReports(d)
setInterval(() => d.store.pruneHistory(settings.historyMaxDays), 6 * 3600_000).unref()
log(`daemon pid=${process.pid} listening on ${SOCK_FILE}, http 127.0.0.1:${settings.httpPort}`)

void d.startPolling(bot => {
  registerTopicCommands(d, bot)
  registerLaunchCommands(d, bot)
  registerInbound(d, bot, TOKEN)
  void bot.api.setMyCommands([
    { command: 'sessions', description: 'Запущенные сессии' },
    { command: 'topics', description: 'Топики проектов' },
    { command: 'connect_group', description: 'Подключить группу с топиками' },
    { command: 'new_session', description: 'Новый проект и сессия в tmux' },
    { command: 'reminders', description: 'Напоминания' },
    { command: 'usage', description: 'Лимиты подписки и расход' },
    { command: 'digest', description: 'Итоги дня' },
    { command: 'reports', description: 'Отчёты о потреблении с графиком' },
    { command: 'status', description: 'Состояние бота и демона' },
    { command: 'help', description: 'Команды' },
  ], { scope: { type: 'all_private_chats' } }).catch(() => {})
}).catch(err => {
  log(`startup failed: ${err}`)
  shutdown(1)
})
