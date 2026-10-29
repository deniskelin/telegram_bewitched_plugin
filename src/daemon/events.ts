/**
 * External events into a project (stage 8 of the TZ).
 *
 * - POST /event (local HTTP) and `bewitched event`: a script, cron or CI step
 *   posts "📡 <source>: <text>" to a project's topic and hands it to the
 *   project's session (launched or queued like any message), so the session
 *   can act on it.
 * - CI watch (CI_WATCH_MIN, via gh): for each project session on a branch,
 *   the latest GitHub Actions run of that branch. A finished run that failed
 *   is posted to the topic with "🛠 Починить" (hands the failure to the
 *   session); green after red is posted too. Nothing goes to the session
 *   without that tap.
 */

import { InlineKeyboard, type Context } from 'grammy'
import { execFile } from 'child_process'
import { isOwner } from '../access.ts'
import { settings } from '../config.ts'
import { clip, escapeHtml, maskSecrets } from '../format.ts'
import type { ChatRef, Daemon, Session } from './daemon.ts'
import { button } from './stream.ts'
import { t as tr } from '../i18n/index.ts'

export type ExternalEvent = { topic?: string; project?: string; text: string; source?: string; silent?: boolean; deliver?: boolean }

/** The topic of a project: by topic name, or by project folder. */
function findTopic(d: Daemon, e: ExternalEvent): { chatId: string; threadId: number; name: string; projectKey: string | null } {
  const chat = d.topicsChatId
  if (!chat) throw new Error('no topics group connected — /connect_group in the bot DM')
  const t = e.topic ? d.store.topicByName(chat, e.topic) : e.project ? d.store.topicForProject(chat, e.project) : null
  if (!t) throw new Error(e.topic || e.project ? `topic for "${e.topic ?? e.project}" not found` : 'topic or project is required')
  return { chatId: chat, threadId: t.thread_id, name: t.name, projectKey: t.project_key ?? null }
}

export async function handleEvent(d: Daemon, e: ExternalEvent): Promise<string> {
  const text = maskSecrets(String(e.text ?? '').trim())
  if (!text) throw new Error('text is required')
  const source = String(e.source ?? 'event').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 32) || 'event'
  const t = findTopic(d, e)
  const sent = await d.bot.api.sendMessage(t.chatId, `📡 ${source}: ${text}`.slice(0, 4096), { message_thread_id: t.threadId, disable_notification: e.silent === true })
  // Only a project's topic has a session of its own to hand the event to.
  if (e.deliver !== false && t.projectKey) {
    const chat: ChatRef = { chatId: t.chatId, threadId: t.threadId, isPrivate: false }
    const meta = { chat_id: t.chatId, thread_id: String(t.threadId), user: source, user_id: 'event', ts: new Date().toISOString(), event: 'external', source }
    await d.routeText(chat, 'event', tr('📡 Внешнее событие ({source}): {text}', { source, text }), meta)
  }
  return `posted to "${t.name}" (id: ${sent.message_id})`
}

// --- CI watch ---

export type CiRun = { databaseId: number; status: string; conclusion: string; name: string; displayTitle: string; url: string }

/** The latest Actions run of a branch, via gh in the project folder. Replaced in tests. */
export let latestRun = (cwd: string, branch: string): Promise<CiRun | null> => new Promise(res => execFile('gh',
  ['run', 'list', '--branch', branch, '--limit', '1', '--json', 'databaseId,status,conclusion,name,displayTitle,url'],
  { cwd, timeout: 15_000 }, (err, out) => {
    if (err) return res(null)
    try {
      res((JSON.parse(String(out)) as CiRun[])[0] ?? null)
    } catch {
      res(null)
    }
  }))
export function setLatestRun(f: typeof latestRun): void {
  latestRun = f
}

const BAD = new Set(['failure', 'timed_out', 'startup_failure'])

/** Failures waiting for "🛠 Починить", by session id. */
const failures = new Map<string, CiRun>()

export async function checkCi(d: Daemon): Promise<void> {
  const seen = new Set<string>()
  for (const s of d.activeSessions()) {
    if (!s.topic || !s.branch || d.roleOf(s) !== 'project') continue
    const key = `ci:${s.projectKey}:${s.branch}`
    if (seen.has(key)) continue
    seen.add(key)
    const run = await latestRun(s.cwd, s.branch)
    if (!run || run.status !== 'completed') continue
    const now = `${run.databaseId}:${run.conclusion}`
    const before = d.store.get(key)
    if (before === now) continue
    d.store.set(key, now)
    // First look at this branch: remember, don't announce an old run.
    if (before == null) continue
    const wasBad = BAD.has(before.split(':')[1] ?? '')
    if (BAD.has(run.conclusion)) await announce(d, s, run, true)
    else if (run.conclusion === 'success' && wasBad) await announce(d, s, run, false)
  }
}

async function announce(d: Daemon, s: Session, run: CiRun, failed: boolean): Promise<void> {
  const head = failed ? tr('❌ <b>CI упал</b> на <code>{v}</code>', { v: escapeHtml(s.branch!) }) : tr('✅ <b>CI снова зелёный</b> на <code>{v}</code>', { v: escapeHtml(s.branch!) })
  const text = `${head}\n${escapeHtml(run.name)} · ${escapeHtml(clip(run.displayTitle, 120))}`
  const row: (ReturnType<typeof button> | ReturnType<typeof InlineKeyboard.url>)[] = [InlineKeyboard.url('🔗 Run', run.url)]
  if (failed) {
    failures.set(s.id, run)
    row.unshift(button(tr('🛠 Починить'), `ci:fix:${s.id}`, 'primary'))
  }
  await d.bot.api.sendMessage(s.topic!.chatId, text, { parse_mode: 'HTML', message_thread_id: s.topic!.threadId, reply_markup: new InlineKeyboard([row] as never) })
    .catch(err => d.log(`ci notice failed: ${err}`))
}

export function startCiWatch(d: Daemon): void {
  const min = settings.ciWatchMin
  if (min <= 0) return
  setInterval(() => void checkCi(d).catch(err => d.log(`ci watch failed: ${err}`)), min * 60_000).unref?.()
}

/** ci:fix:<session id> — hand the failed run to the session. */
export async function handleCiCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^ci:fix:([0-9a-f]+)$/.exec(data)
  if (!m) return false
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: tr('Нет доступа.') }).catch(() => {})
    return true
  }
  const s = d.sessions.get(m[1])
  const run = failures.get(m[1])
  if (!s || !run || !s.topic) {
    await ctx.answerCallbackQuery({ text: tr('Сессия переподключилась — напишите ей сами.') }).catch(() => {})
    return true
  }
  failures.delete(m[1])
  await ctx.answerCallbackQuery({ text: tr('🛠 Отправил сессии') }).catch(() => {})
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard([[InlineKeyboard.url('🔗 Run', run.url)]]) }).catch(() => {})
  const chat: ChatRef = { chatId: s.topic.chatId, threadId: s.topic.threadId, isPrivate: false }
  const text = tr('CI упал на ветке {branch}: «{name}» ({url}). Посмотри `gh run view {databaseId} --log-failed`, найди причину, почини и запушь.', { branch: s.branch ?? '', name: run.name, url: run.url, databaseId: run.databaseId })
  await d.routeText(chat, String(ctx.from.id), text, {
    chat_id: chat.chatId, thread_id: String(chat.threadId), user_id: String(ctx.from.id), user: d.userLabel(String(ctx.from.id)),
    ts: new Date().toISOString(), event: 'ci_failure', run_id: String(run.databaseId),
  })
  return true
}
