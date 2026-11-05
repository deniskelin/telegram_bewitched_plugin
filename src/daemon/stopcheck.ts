import { applySessionEvent } from '../core/session.ts'
import { finishStage } from './taskcost.ts'
/** Never report an Escape as proof that a remote process stopped. */
import type { Daemon, Session } from './daemon.ts'
import { engineOf } from './engines.ts'
import { isQuestion } from './screen.ts'
import { sessionTarget } from './topics.ts'
import { sessionPhase } from './ux.ts'
import { inChat } from './lang.ts'
import { t } from '../i18n/index.ts'
export async function verifyStop(d: Daemon, s: Session, at: number, expectedToken?: number): Promise<boolean> {
  if (!d.sessions.has(s.id) || s.stoppedAt !== at || s.stopRequest?.phase !== 'sent' || expectedToken !== undefined && expectedToken !== s.stopRequest.token) return false
  const token = s.stopRequest.token
  const raw = s.tmuxPane ? await d.tmuxCapture(s.tmuxPane) : null
  if (s.stoppedAt !== at) return false
  const idle = s.status === 'idle' || raw != null && engineOf(s.engine).isPromptReady(raw) && !isQuestion(raw) && !/esc to interrupt/i.test(raw)
  if (!applySessionEvent(s, { type: 'stop_checked', at, token, idle, checkedAt: Date.now() }).accepted) return false
  if (idle) { finishStage(d, s); sessionPhase(d, s, 'stopped') }
  const c = s.lastChat ?? sessionTarget(d, s)
  if (c && process.env.STOP_NOTICES !== 'off') await inChat(d, c.chatId, c.threadId, () => d.bot.api.sendMessage(c.chatId, idle ? t('Остановка подтверждена') : raw != null ? t('Команда остановки отправлена; агент ещё работает.') : t('Остановка не подтверждена'), { message_thread_id: c.threadId, disable_notification: true })).catch(err => d.log(`stop verification notice: ${err}`))
  d.onSessionsChanged()
  return idle
}
