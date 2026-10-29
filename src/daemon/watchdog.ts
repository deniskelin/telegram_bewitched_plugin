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
import { can, owner } from '../access.ts'
import { settings } from '../config.ts'
import { escapeHtml } from '../format.ts'
import type { Daemon, Session } from './daemon.ts'
import { launchCommand, launchForTopic, manualCmd, screenKb, sessionName, watchLaunch } from './launch.ts'
import { button } from './stream.ts'
import { guessTranscript } from './transcript.ts'
import { t as tr } from '../i18n/index.ts'
import { inSession } from './lang.ts'

/** session: -n <name> and the tmux window name. */
type Restart = { dir: string; resume: string | null; name: string; session?: string }

export function onSessionStopped(d: Daemon, s: Session): void {
  if (s.passive || d.ending.delete(s.id)) return
  const transcript = s.claude.transcript ?? guessTranscript(s.argv, s.cwd)
  const resume = s.claude.sessionId ?? (transcript ? basename(transcript, '.jsonl') : null)
  setTimeout(() => void inSession(d, s, () => notifyStopped(d, s, resume)).catch(err => d.log(`watchdog notice failed: ${err}`)), settings.watchdogGraceSec * 1000).unref?.()
}

async function notifyStopped(d: Daemon, s: Session, resume: string | null): Promise<void> {
  if (d.activeSessions().some(o => o.projectKey === s.projectKey)) return // restarted meanwhile
  const role = d.roleOf(s)
  const user = d.userIdOf(s)
  const name = user ? `👤 ${d.userLabel(user)}` : role === 'main' ? tr('👑 главная') : `📂 ${s.projectName}`
  const restart: Restart = { dir: s.cwd, resume, name, session: sessionName(d, s.projectKey) }
  const id = randomBytes(4).toString('hex')
  d.store.set(`wd:${id}`, JSON.stringify(restart))

  const text = [
    tr('⚠️ Сессия <b>{v}</b> (#{id}) остановилась.', { v: escapeHtml(name), id: s.id }),
    '',
    tr('Запустить заново в терминале:'),
    tr('<pre>tmux attach -t {v}  # или: tmux new -s {v}</pre>', { v: escapeHtml(settings.tmuxSession) }),
    manualCmd(s.cwd, { resume: resume ?? undefined, continue: !resume, name: restart.session }),
    tr('и примите экран подтверждения каналов. Или кнопкой — запущу в новом окне tmux.'),
  ].join('\n')
  const kb = new InlineKeyboard([[button(tr('🚀 Запустить'), `wd:run:${id}`, 'success')]])

  const chat = d.topicsChatId
  const topic = role === 'project' && chat ? d.store.topicForProject(chat, s.projectKey) : null
  if (topic && topic.status === 'active') {
    await d.bot.api.sendMessage(chat!, tr('{text}\nТопик закрыт, пока сессия не подключится; сообщения в него ставятся в очередь.', { text }), { parse_mode: 'HTML', message_thread_id: topic.thread_id, reply_markup: kb })
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
  if (!ctx.from || !can(ctx.from.id, 'control')) {
    await answer(tr('Нет доступа.'))
    return true
  }
  if (m[1] === 'topic') {
    const chat = d.topicsChatId
    const t = chat ? d.store.topic(chat, Number(m[2])) : null
    if (!chat || !t?.project_key) { await answer(tr('Топик не привязан к проекту.')); return true }
    await answer(tr('🚀 Запускаю'))
    await launchForTopic(d, chat, t.thread_id, t.project_key)
    return true
  }
  const raw = d.store.get(`wd:${m[2]}`)
  if (!raw) { await answer(tr('Уже неактуально.')); return true }
  const r = JSON.parse(raw) as Restart
  if (d.activeSessions().some(s => s.cwd === r.dir)) { await answer(tr('Сессия уже работает.')); return true }
  try {
    const o = { resume: r.resume ?? undefined, continue: !r.resume, name: r.session }
    const win = await d.launchSession(r.dir, o)
    d.launching.set(r.dir, Date.now())
    watchLaunch(d, r.dir, win)
    d.store.set(`wd:${m[2]}`, null)
    await answer(tr('🚀 Запускаю'))
    await ctx.editMessageText(
      tr('🚀 Запускаю <b>{v}</b> в tmux: окно {v2}.\nПодтвердите:<pre>tmux attach -t {v3}:{v2}</pre>и примите экран подтверждения каналов (или кнопкой «👁 Экран»).\n<code>{v4}</code>', { v: escapeHtml(r.name), v2: escapeHtml(win), v3: escapeHtml(settings.tmuxSession), v4: escapeHtml(launchCommand(o)) }),
      { parse_mode: 'HTML', reply_markup: screenKb(win) },
    ).catch(() => {})
  } catch (err) {
    await answer(tr('Не удалось: {v}', { v: String(err instanceof Error ? err.message : err) }).slice(0, 190))
  }
  return true
}
