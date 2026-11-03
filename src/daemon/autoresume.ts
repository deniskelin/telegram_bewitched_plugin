/**
 * Idle wake-up: a session suspended for idling (idle.ts, launch.ts
 * startIdleCloser) wakes up by itself on the next message to it. Nobody is
 * told in the chats — the suspension, the wake-up and its outcome go to the
 * journal («🖥 Сессии», the botlog; the owner's DM without one). The session
 * is started with its conversation (the one it had, or the last one of its
 * engine in the folder) and its startup prompt is answered: the owner chose
 * idle suspension, the wake-up is part of it. Only a wake-up that fails is
 * told to the chat as well — the message waits in the queue.
 */

import { basename, relative } from 'path'
import { settings } from '../config.ts'
import { escapeHtml } from '../format.ts'
import { t } from '../i18n/index.ts'
import type { Daemon, Session } from './daemon.ts'
import { projectEngine, type EngineId } from './engines.ts'
import { sendNotice } from './journal.ts'
import { inChat } from './lang.ts'
import { attachTarget, awaitConnect, continueOptions, launchOnce, screenKb, sessionName } from './launch.ts'

/** A suspended session: when, on which engine, the conversation it had, for how long it idled. */
export type IdleRecord = { at: number; engine: EngineId; resume: string | null; period: string; id: string }

const key = (dir: string) => `idle_suspended:${dir}`

export function idleRecord(d: Daemon, dir: string): IdleRecord | null {
  try {
    return JSON.parse(d.store.get(key(dir)) ?? '') as IdleRecord
  } catch {
    return null
  }
}

/** Set before the session is closed: its disconnect is then quiet in its chat. */
export function markIdle(d: Daemon, s: Session, period: string): void {
  const r: IdleRecord = { at: Date.now(), engine: s.engine, resume: s.claude.sessionId, period, id: s.id }
  d.store.set(key(s.cwd), JSON.stringify(r))
}

export function clearIdle(d: Daemon, dir: string): void {
  if (d.store.get(key(dir)) != null) d.store.set(key(dir), null)
}

/** Folders woken up by the daemon, until their session connects: its «🟢 Сессия подключена» card stays out of the chat. */
export const quietConnect = new Set<string>()

/** How the journal names a session's folder: the user, the project's topic, or the folder. */
function who(d: Daemon, dir: string): string {
  const user = /^(\d+)$/.exec(relative(settings.usersDir, dir))?.[1]
  if (user) return `👤 ${d.userLabel(user)}`
  const topic = d.topicsChatId ? d.store.topicForProject(d.topicsChatId, dir) : null
  return `📂 ${topic?.name ?? basename(dir)}`
}

/** The journal line of a suspension (instead of notices in the chat and DMs). */
export async function logSuspended(d: Daemon, s: Session, period: string): Promise<void> {
  d.log(`session ${s.id} suspended after ${period} idle; it wakes up on the next message`)
  await sendNotice(d, 'sessions', () => t('💤 Сессия <b>{v}</b> (#{id}, {engine}) приостановлена: {period} без дела. Следующее сообщение поднимет её само.', { v: escapeHtml(who(d, s.cwd)), id: s.id, engine: s.engine, period }), () => ({ disable_notification: true }))
}

/**
 * A message came for a suspended session: start it again. True when it is
 * handled here (started, or already starting) — the caller says nothing in
 * the chat; false — not a suspended session, or the start failed (the
 * caller's own path reports it).
 */
export async function autoResume(d: Daemon, dir: string, from: string, where: { chatId: string; threadId?: number }): Promise<boolean> {
  const rec = idleRecord(d, dir)
  if (!rec) return false
  const engine = projectEngine(d, dir).engine
  const conv = rec.resume && rec.engine === engine ? { resume: rec.resume } : continueOptions(d, dir, engine)
  const l = await launchOnce(d, dir, { name: sessionName(d, dir, engine), ...conv }, false)
  if (!l.ok && l.skipped) return true
  const name = escapeHtml(who(d, dir))
  if (!l.ok) {
    clearIdle(d, dir)
    d.log(`wake-up of ${dir} failed: ${l.error}`)
    await sendNotice(d, 'sessions', () => t('❌ Сессия <b>{v}</b> не поднялась сама: {v2}', { v: name, v2: escapeHtml(l.error) }))
    return false
  }
  quietConnect.add(dir)
  const kept = conv.resume || conv.continue ? t('разговор продолжается') : t('новый разговор')
  d.log(`wake-up of ${dir} (${engine}): window ${l.window}, message from ${from}`)
  await sendNotice(d, 'sessions', () => t('🔄 Сессия <b>{v}</b> поднимается сама: пришло сообщение ({who}). {engine}, окно {win}, {kept}.', { v: name, who: escapeHtml(from || '?'), engine, win: escapeHtml(attachTarget(l.window)), kept }), () => ({ disable_notification: true }))
  void watchWakeUp(d, dir, l.window, name, where).catch(err => d.log(`wake-up watch of ${dir} failed: ${err}`))
  return true
}

async function watchWakeUp(d: Daemon, dir: string, win: string, name: string, where: { chatId: string; threadId?: number }): Promise<void> {
  const r = await awaitConnect(d, dir, win, { confirm: true })
  if (r.ok) {
    clearIdle(d, dir)
    d.log(`wake-up of ${dir}: session ${r.session.id} connected in ${r.ms} ms`)
    await sendNotice(d, 'sessions', () => t('✅ Сессия <b>{v}</b> (#{id}) снова в работе: подключилась за {n} с.', { v: name, id: r.session.id, n: Math.round(r.ms / 1000) }), () => ({ disable_notification: true }))
    return
  }
  quietConnect.delete(dir)
  const why = r.reason === 'gone' ? t('окно закрылось') : r.reason === 'stuck' ? t('на экране вопрос, на который я не отвечаю сам') : t('не подключилась за {n} с', { n: Math.round(r.ms / 1000) })
  d.log(`wake-up of ${dir} did not connect: ${r.reason}`)
  await sendNotice(d, 'sessions', () => t('⚠️ Сессия <b>{v}</b> не поднялась сама: {why}. Сообщения ждут в очереди — посмотрите экран.', { v: name, why }), () => ({ reply_markup: screenKb(win) }))
  await inChat(d, where.chatId, where.threadId, () => d.bot.api.sendMessage(where.chatId, t('⏳ Сессия запускается дольше обычного — сообщение в очереди, владелец получил уведомление.'), {
    ...(where.threadId != null ? { message_thread_id: where.threadId } : {}),
    disable_notification: true,
  })).catch(err => d.log(`wake-up notice failed: ${err}`))
}
