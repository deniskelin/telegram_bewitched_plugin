/**
 * 🌙 Quiet hours: between these times every message the bot sends goes
 * without sound (disable_notification), unless the call already decided.
 * Nothing is held back: reminders and "✅ Готово" arrive on time, silently.
 * QUIET_HOURS=23:00-08:00 in .env, or the buttons in /menu → ⚙️ (stored,
 * wins over .env); "off" — never.
 */

import type { Bot } from 'grammy'
import { settings } from '../config.ts'
import type { Daemon } from './daemon.ts'

export const QUIET_PRESETS = ['off', '22:00-07:00', '23:00-08:00', '00:00-09:00'] as const

const SEND = /^send(Message|Photo|Document|Voice|Audio|Video|VideoNote|Animation|MediaGroup|RichMessage|Sticker|Location|Poll)$/

/** "HH:MM-HH:MM" → minutes from midnight; null for off or nonsense. */
export function parseQuiet(v: string | null | undefined): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(v ?? '')
  if (!m) return null
  const a = Number(m[1]) * 60 + Number(m[2])
  const b = Number(m[3]) * 60 + Number(m[4])
  return a < 1440 && b < 1440 && a !== b ? [a, b] : null
}

export function quietHours(d: Daemon): string {
  return d.store.get('quiet_hours') ?? settings.quietHours
}

/** Inside the window (it may cross midnight), by the server's local time. */
export function isQuiet(range: [number, number] | null, at = new Date()): boolean {
  if (!range) return false
  const t = at.getHours() * 60 + at.getMinutes()
  const [a, b] = range
  return a < b ? t >= a && t < b : t >= a || t < b
}

export function fmtQuiet(v: string): string {
  return parseQuiet(v) ? v.replace('-', '–') : 'выкл'
}

export function installQuietHours(d: Daemon, bot: Bot): void {
  bot.api.config.use((prev, method, payload, signal) => {
    if (SEND.test(method) && payload && (payload as { disable_notification?: boolean }).disable_notification == null && isQuiet(parseQuiet(quietHours(d)))) {
      payload = { ...payload, disable_notification: true }
    }
    return prev(method, payload, signal)
  })
}
