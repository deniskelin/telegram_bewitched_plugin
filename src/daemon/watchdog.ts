/**
 * Session watchdog — the daemon's "technical" duty. A session that goes away
 * on its own (not archived, not closed for idling) is reported in its chat
 * after WATCHDOG_GRACE_SEC, unless it came back meanwhile: the commands to
 * start it again and a 🚀 button. A project topic is closed until the
 * session reconnects (ensureTopic reopens it).
 *
 * From outside, /exit typed in the terminal looks the same as a crash, so the
 * notice says "stopped", not "crashed".
 */

import { InlineKeyboard, type Context } from 'grammy'
import { randomBytes } from 'crypto'
import { basename } from 'path'
import { isOwner, owner } from '../access.ts'
import { settings } from '../config.ts'
import { escapeHtml } from '../format.ts'
import type { Daemon, Session } from './daemon.ts'
import { launchCommand, launchForTopic, manualCmd, screenKb, sessionName } from './launch.ts'
import { button } from './stream.ts'
import { guessTranscript } from './transcript.ts'

/** session: -n <name> and the tmux window name. */
type Restart = { dir: string; resume: string | null; name: string; session?: string }

export function onSessionStopped(d: Daemon, s: Session): void {
  if (s.passive || d.ending.delete(s.id)) return
  const transcript = s.claude.transcript ?? guessTranscript(s.argv, s.cwd)
  const resume = s.claude.sessionId ?? (transcript ? basename(transcript, '.jsonl') : null)
  setTimeout(() => void notifyStopped(d, s, resume).catch(err => d.log(`watchdog notice failed: ${err}`)), settings.watchdogGraceSec * 1000).unref?.()
}

async function notifyStopped(d: Daemon, s: Session, resume: string | null): Promise<void> {
  if (d.activeSessions().some(o => o.projectKey === s.projectKey)) return // restarted meanwhile
  const role = d.roleOf(s)
  const user = d.userIdOf(s)
  const name = user ? `👤 ${d.store.lastSenderName(user) ?? user}` : role === 'main' ? '👑 главная' : `📂 ${s.projectName}`
  const restart: Restart = { dir: s.cwd, resume, name, session: sessionName(d, s.projectKey) }
  const id = randomBytes(4).toString('hex')
  d.store.set(`wd:${id}`, JSON.stringify(restart))

  const text = [
    `⚠️ Сессия <b>${escapeHtml(name)}</b> (#${s.id}) остановилась.`,
    '',
    'Запустить заново в терминале:',
    `<pre>tmux attach -t ${escapeHtml(settings.tmuxSession)}  # или: tmux new -s ${escapeHtml(settings.tmuxSession)}</pre>`,
    manualCmd(s.cwd, { resume: resume ?? undefined, continue: !resume, name: restart.session }),
    'и примите экран подтверждения каналов. Или кнопкой — запущу в новом окне tmux.',
  ].join('\n')
  const kb = new InlineKeyboard([[button('🚀 Запустить', `wd:run:${id}`, 'success')]])

  const chat = d.topicsChatId
  const topic = role === 'project' && chat ? d.store.topicForProject(chat, s.projectKey) : null
  if (topic && topic.status === 'active') {
    await d.bot.api.sendMessage(chat!, `${text}\nТопик закрыт, пока сессия не подключится; сообщения в него ставятся в очередь.`, { parse_mode: 'HTML', message_thread_id: topic.thread_id, reply_markup: kb })
    d.store.setTopicStatus(chat!, topic.thread_id, 'waiting')
    await d.bot.api.closeForumTopic(chat!, topic.thread_id).catch(err => d.log(`closeForumTopic failed: ${err}`))
    return
  }
  const to = user ?? owner()
  if (to) await d.bot.api.sendMessage(to, text, { parse_mode: 'HTML', reply_markup: kb })
}

/** wd:run:<id> — restart a stopped session; wd:topic:<thread> — start a waiting topic's session. */
export async function handleWatchdogCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^wd:(run|topic):([0-9a-f]+|\d+)$/.exec(data)
  if (!m) return false
  const answer = (t?: string) => ctx.answerCallbackQuery(t ? { text: t } : undefined).catch(() => {})
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await answer('Нет доступа.')
    return true
  }
  if (m[1] === 'topic') {
    const chat = d.topicsChatId
    const t = chat ? d.store.topic(chat, Number(m[2])) : null
    if (!chat || !t?.project_key) { await answer('Топик не привязан к проекту.'); return true }
    await answer('🚀 Запускаю')
    await launchForTopic(d, chat, t.thread_id, t.project_key)
    return true
  }
  const raw = d.store.get(`wd:${m[2]}`)
  if (!raw) { await answer('Уже неактуально.'); return true }
  const r = JSON.parse(raw) as Restart
  if (d.activeSessions().some(s => s.cwd === r.dir)) { await answer('Сессия уже работает.'); return true }
  try {
    const o = { resume: r.resume ?? undefined, continue: !r.resume, name: r.session }
    const win = await d.launchSession(r.dir, o)
    d.launching.set(r.dir, Date.now())
    d.store.set(`wd:${m[2]}`, null)
    await answer('🚀 Запускаю')
    await ctx.editMessageText(
      `🚀 Запускаю <b>${escapeHtml(r.name)}</b> в tmux: окно ${escapeHtml(win)}.\nПодтвердите:<pre>tmux attach -t ${escapeHtml(settings.tmuxSession)}:${escapeHtml(win)}</pre>и примите экран подтверждения каналов (или кнопкой «👁 Экран»).\n<code>${escapeHtml(launchCommand(o))}</code>`,
      { parse_mode: 'HTML', reply_markup: screenKb(win) },
    ).catch(() => {})
  } catch (err) {
    await answer(`Не удалось: ${String(err instanceof Error ? err.message : err)}`.slice(0, 190))
  }
  return true
}
