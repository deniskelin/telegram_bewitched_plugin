/**
 * Session watchdog — the daemon's "technical" duty. A session that goes away
 * on its own (not archived, not closed for idling) is reported after
 * WATCHDOG_GRACE_SEC, unless it came back meanwhile. The commands to start it
 * again and the 🚀 button go to the owner only: a topic is seen by everyone,
 * and a member could neither run them nor press 🚀. A member whose own
 * session stopped gets a «🙋 Запросить перезапуск» button that asks the
 * owner. A project topic is closed until the session reconnects (ensureTopic
 * reopens it).
 *
 * From outside, /exit typed in the terminal looks the same as a crash, so the
 * notice says "stopped", not "crashed".
 */

import { checkCodexApproval } from './codexapproval.ts'
import { InlineKeyboard, type Context } from 'grammy'
import { randomBytes } from 'crypto'
import { statSync } from 'fs'
import { basename, relative } from 'path'
import { can, owner } from '../access.ts'
import { settings } from '../config.ts'
import { escapeHtml } from '../format.ts'
import type { Daemon, Session } from './daemon.ts'
import type { EngineId } from './engines.ts'
import { exitCodeSince, attachTarget, awaitConnect, windowTarget, endSession, launchCommand, launchForTopic, launchOnce, manualCmd, screenKb, sessionName, waitGone, endTiming } from './launch.ts'
import { button } from './stream.ts'
import { guessTranscript } from './transcript.ts'
import { t as tr } from '../i18n/index.ts'
import { inChat, inSession } from './lang.ts'
import { projectTitle } from './report.ts'
import { sendNotice } from './journal.ts'
import { endTurnQuietly } from './http.ts'
import { sessionTarget } from './topics.ts'
import { confirmLaunch, isQuestion, isStartupPrompt, questionSig, screenView, shownQuestions } from './screen.ts'

/**
 * session: -n <name> and the tmux name; user: whose session it was; sent: the
 * notices in DMs, deleted when the session is back or a newer notice replaces
 * them; v: 2 for records made since notices go to the owner (older ones are
 * announced again once, see renotifyStopped).
 */
/** engine: the CLI the stopped session ran; its conversation id (resume) belongs to that engine only. */
type Restart = { dir: string; resume: string | null; name: string; session?: string; user?: string; sent?: { chat: string; id: number }[]; v?: number; engine?: EngineId }

export function onSessionStopped(d: Daemon, s: Session): void {
  if (s.passive || d.ending.delete(s.id)) return
  const transcript = s.claude.transcript ?? guessTranscript(s.argv, s.cwd)
  const resume = s.claude.sessionId ?? (transcript ? basename(transcript, '.jsonl') : null)
  setTimeout(() => void (async () => {
    // FR-19: exit code 0 — /exit or /quit typed in the terminal (Codex has no SessionEnd hook): a planned end.
    const code = exitCodeSince(s.cwd, s.connectedAt)
    if (code === 0) return void d.log(`session ${s.id}: exited normally (code 0), no notice`)
    await inSession(d, s, () => notifyStopped(d, s, resume, code))
  })().catch(err => d.log(`watchdog notice failed: ${err}`)), settings.watchdogGraceSec * 1000).unref?.()
}

async function notifyStopped(d: Daemon, s: Session, resume: string | null, code: number | null = null): Promise<void> {
  if (d.activeSessions().some(o => o.projectKey === s.projectKey)) return // restarted meanwhile
  const role = d.roleOf(s)
  const user = d.userIdOf(s)
  const name = user ? `👤 ${d.userLabel(user)}` : `📂 ${projectTitle(s)}`
  const restart: Restart = { dir: s.cwd, resume, name, session: sessionName(d, s.projectKey, s.engine), user: user ?? undefined, v: 2, engine: s.engine }
  await dropStale(d, s.cwd)
  const id = randomBytes(4).toString('hex')

  const chat = d.topicsChatId
  const topic = role === 'project' && chat ? d.store.topicForProject(chat, s.projectKey) : null
  if (topic && topic.status === 'active') {
    await d.bot.api.sendMessage(chat!, tr('⚠️ Сессия <b>{v}</b> (#{id}) остановилась. Владелец получил уведомление.\nТопик закрыт, пока сессия не подключится; сообщения в него ставятся в очередь.', { v: escapeHtml(name), id: s.id }), { parse_mode: 'HTML', message_thread_id: topic.thread_id })
    d.store.setTopicStatus(chat!, topic.thread_id, 'waiting')
    await d.bot.api.closeForumTopic(chat!, topic.thread_id).catch(err => d.log(`closeForumTopic failed: ${err}`))
  }
  const why = () => (code == null ? '' : '\n' + (code === 137 ? tr('Код выхода 137: процесс убит (часто — нехватка памяти).') : tr('Код выхода {code}: сбой, а не /exit.', { code })))
  await announce(d, restart, id, () => tr('⚠️ Сессия <b>{v}</b> (#{id}) остановилась.', { v: escapeHtml(name), id: s.id }) + why(), !topic || topic.status !== 'active')
}

/**
 * The DM notices of a stopped session: its member user gets «🙋 Запросить
 * перезапуск» (when tellUser), the owner the commands and 🚀. Saved under
 * wd:<id> with the sent message ids.
 */
async function announce(d: Daemon, r: Restart, id: string, ownerHead: () => string, tellUser: boolean, userText: () => string = () => tr('⚠️ Ваша сессия остановилась. Можно попросить владельца бота запустить её заново.'), askLabel: () => string = () => tr('🙋 Запросить перезапуск')): Promise<void> {
  const o = owner()
  const sent: { chat: string; id: number }[] = []
  if (tellUser && r.user && r.user !== o) {
    const user = r.user
    const ask = inChat(d, user, undefined, () => new InlineKeyboard([[button(askLabel(), `wd:ask:${id}`, 'primary')]]))
    const m = await d.bot.api.sendMessage(user, inChat(d, user, undefined, userText), { parse_mode: 'HTML', reply_markup: ask }).catch(err => { d.log(`watchdog notice failed: ${err}`); return null })
    if (m) sent.push({ chat: user, id: m.message_id })
  }
  const n = await sendNotice(d, 'sessions', () => ownerNotice(r, ownerHead()), () => ({ reply_markup: runKb(id) }))
  if (n) sent.push({ chat: n.chat, id: n.msg.message_id })
  d.store.set(`wd:${id}`, JSON.stringify({ ...r, sent }))
}

/** Forget the notices about dir: delete their messages (but keep) and their records. */
async function dropStale(d: Daemon, dir: string, keep?: { chat: string; id: number }): Promise<void> {
  for (const key of d.store.keys('wd:')) {
    let r: Restart
    try { r = JSON.parse(d.store.get(key) ?? '') as Restart } catch { continue }
    if (r.dir !== dir) continue
    for (const m of r.sent ?? []) {
      if (keep && m.chat === keep.chat && m.id === keep.id) continue
      await d.bot.api.deleteMessage(m.chat, m.id).catch(() => {})
    }
    d.store.set(key, null)
  }
}

/** A session connected: its stopped-notices are out of date. */
export function onSessionBack(d: Daemon, dir: string): void {
  void dropStale(d, dir).catch(err => d.log(`watchdog cleanup failed: ${err}`))
}

/**
 * Once after the daemon starts (when sessions had time to reconnect): records
 * of sessions that are back are dropped; notices from before v2 (commands and
 * 🚀 to anyone) are sent again the new way — the old messages' ids were not
 * kept, so they stay.
 */
export async function renotifyStopped(d: Daemon): Promise<void> {
  for (const key of d.store.keys('wd:')) {
    let r: Restart
    try { r = JSON.parse(d.store.get(key) ?? '') as Restart } catch { continue }
    if (d.activeSessions().some(s => s.cwd === r.dir)) { await dropStale(d, r.dir); continue }
    if (r.v === 2) continue
    d.store.set(key, null)
    for (const m of r.sent ?? []) await d.bot.api.deleteMessage(m.chat, m.id).catch(() => {})
    const user = /^(\d+)$/.exec(relative(settings.usersDir, r.dir))?.[1]
    const fresh: Restart = { ...r, user, session: sessionName(d, r.dir), sent: undefined, v: 2 }
    await announce(d, fresh, key.slice(3), () => tr('⚠️ Сессия <b>{v}</b> остановилась.', { v: escapeHtml(r.name) }), true)
  }
}

function runKb(id: string): InlineKeyboard {
  return new InlineKeyboard([[button(tr('🚀 Запустить'), `wd:run:${id}`, 'success')]])
}

/** For the owner: what happened, the commands to start it again, and the 🚀 button below. */
function ownerNotice(r: Restart, head: string): string {
  return [
    head,
    '',
    tr('Запустить заново в терминале:'),
    tr('<pre>tmux attach -t {v}  # или: tmux new -s {v}</pre>', { v: escapeHtml(r.session ?? settings.tmuxSession) }),
    manualCmd(r.dir, { ...(r.engine ? { engine: r.engine } : {}), resume: r.resume ?? undefined, continue: !r.resume, name: r.session }),
    tr('и примите экран подтверждения каналов. Или кнопкой — запущу в новом окне tmux.'),
  ].join('\n')
}

// --------------------------------------------------------------------------
// A turn nobody took
// --------------------------------------------------------------------------

/**
 * A message was delivered, the chat shows «⏳ Работаю…», but the session gives
 * no sign of life: no hook and no transcript write since the turn began
 * (2026-11-01: a session broken by a failed /exit «worked» for 31 min). After
 * TURN_STUCK_SEC (120 by default, 0 — off) the chat gets its screen and
 * «♻️ Перезапустить» / «⏹ Стоп», once per turn.
 */
export function startTurnWatch(d: Daemon): void {
  setInterval(() => void checkTurns(d).catch(err => d.log(`turn watch failed: ${err}`)), 15_000).unref?.()
}

export async function checkTurns(d: Daemon, now = Date.now()): Promise<void> {
  const sec = Number(process.env.TURN_STUCK_SEC ?? 120)
  if (!(sec > 0)) return
  for (const s of d.activeSessions()) {
    const turn = s.turn
    if (!turn || turn.stuck || now - turn.start < sec * 1000) continue
    if (s.lastHookAt >= turn.start || transcriptSince(s, turn.start)) continue
    turn.stuck = true
    d.log(`session ${s.id}: no sign of life ${Math.round((now - turn.start) / 1000)} s after a message`)
    await warnStuck(d, s, Math.round((now - turn.start) / 60_000))
  }
}

function transcriptSince(s: Session, since: number): boolean {
  const path = s.claude.transcript ?? guessTranscript(s.argv, s.cwd)
  try {
    return !!path && statSync(path).mtimeMs >= since
  } catch {
    return false
  }
}

async function warnStuck(d: Daemon, s: Session, min: number): Promise<void> {
  const c = s.lastChat ?? sessionTarget(d, s)
  if (!c) return
  const screen = s.tmuxPane ? ((await d.tmuxCapture(s.tmuxPane)) ?? '').split('\n').filter(l => l.trim()).slice(-12).join('\n') : ''
  await inChat(d, c.chatId, c.threadId, async () => {
    const text = tr('⚠️ Сессия #{id} не берёт сообщение: {min} мин без признаков работы.', { id: s.id, min: Math.max(min, 1) })
      + (screen ? `\n${tr('Экран:')}\n<pre>${escapeHtml(screen)}</pre>` : '')
    const rows = [[button(tr('♻️ Перезапустить'), `wd:re:${s.id}`, 'primary'), button(tr('⏹ Стоп'), `stop:${s.id}`, 'danger')]]
    // Often it is a question on the screen (a menu, a confirmation): answering it is enough.
    if (s.tmuxPane && /^%\d+$/.test(s.tmuxPane)) rows.unshift([button(tr('👁 Экран и клавиши'), `tx:p${s.tmuxPane.slice(1)}`)])
    const kb = new InlineKeyboard(rows)
    await d.bot.api.sendMessage(c.chatId, text, { parse_mode: 'HTML', reply_markup: kb, ...(c.threadId ? { message_thread_id: c.threadId } : {}) })
  }).catch(err => d.log(`stuck notice failed: ${err}`))
}

// --------------------------------------------------------------------------
// A question nobody answers (FR-19)
// --------------------------------------------------------------------------

/** pane → the question seen at the last check: a question must survive two checks (not a redraw). */
const pendingQuestions = new Map<string, string>()

/**
 * A question on a session's screen that nobody answers — Codex's «Trust this
 * folder?» / «Hooks need review», an update prompt, a menu left open. Until
 * it is answered the session takes no messages. Seen on two checks in a row,
 * the session's chat gets its screen with keys, once per question. Claude's
 * permission requests are skipped: they come with buttons already.
 */
export function startQuestionWatch(d: Daemon): void {
  setInterval(() => void checkQuestions(d).catch(err => d.log(`question watch failed: ${err}`)), 20_000).unref?.()
}

/** Launch windows whose startup questions are being answered now. */
const confirmingLaunches = new Set<string>()

/**
 * A launch the daemon started itself (a restart after a disconnect, a user
 * session for a message) that stopped on a startup question — Codex's
 * «Hooks need review», a folder's trust: nobody waits on its window, and the
 * session never connects. Answered here, the same questions «✅ Подтвердить
 * запуск» answers; anything else is left to the chat.
 */
async function confirmPendingLaunches(d: Daemon): Promise<void> {
  for (const [dir, win] of d.launchWindows) {
    const target = windowTarget(win)
    if (confirmingLaunches.has(target) || d.activeSessions().some(x => x.cwd === dir || x.projectKey === dir)) continue
    if (!isStartupPrompt(await d.tmuxCapture(target))) continue
    confirmingLaunches.add(target)
    d.log(`launch ${dir}: a startup question in ${win}, answering it`)
    void confirmLaunch(d, target)
      .then(r => d.log(`launch ${dir}: startup questions → ${r.result}`))
      .catch(err => d.log(`launch ${dir}: confirm failed: ${err}`))
      .finally(() => confirmingLaunches.delete(target))
  }
}

/** A turn with nothing from its session for this long is checked against the screen. */
const PHANTOM_TURN_MS = 60_000

/**
 * A turn that ended without a Stop hook — interrupted with Esc in the window
 * (Codex then sends none), or opened by a stray tool call between turns — and
 * went quiet: if the screen shows no work under way (no «esc to interrupt»),
 * no question and no permission request, nothing is running and no Stop will
 * come. The session is idle again, silently; Codex gets what was held for it.
 */
export async function closePhantomTurns(d: Daemon, now = Date.now()): Promise<void> {
  for (const s of d.activeSessions()) {
    // Only a turn the session began (a hook came after it opened): one that never took its message is
    // the «не берёт сообщение» watch's (checkTurns), not this one's.
    // (A turn opened by a hook starts a moment after that hook was noted: a second of slack.)
    if (!s.turn || !s.tmuxPane || s.lastHookAt < s.turn.start - 1000) continue
    const quiet = now - Math.max(s.lastHookAt, s.turn.start)
    if (quiet < PHANTOM_TURN_MS) continue
    if ([...d.permissions.values()].some(p => p.sessionId === s.id)) continue
    const raw = await d.tmuxCapture(s.tmuxPane)
    if (raw == null || /esc to interrupt/i.test(raw) || isQuestion(raw)) continue
    d.log(`session ${s.id}: a turn ${s.turn.byHook ? 'opened by a tool call' : 'without a Stop'}, quiet for ${Math.round(quiet / 1000)} s and nothing under way on the screen — idle again`)
    endTurnQuietly(d, s)
  }
}

export async function checkQuestions(d: Daemon): Promise<void> {
  await confirmPendingLaunches(d).catch(err => d.log(`pending launches check failed: ${err}`))
  await closePhantomTurns(d).catch(err => d.log(`phantom turns check failed: ${err}`))
  for (const s of d.activeSessions()) {
    const pane = s.tmuxPane
    if (!pane || !/^%\d+$/.test(pane)) continue
    if ([...d.permissions.values()].some(p => p.sessionId === s.id)) continue
    // Codex's approval requests get their own card with buttons (codexapproval.ts).
    if (await checkCodexApproval(d, s)) continue
    const raw = await d.tmuxCapture(pane)
    const sig = raw && isQuestion(raw) ? questionSig(raw) : null
    if (!sig) {
      pendingQuestions.delete(pane)
      shownQuestions.delete(pane)
      continue
    }
    if (shownQuestions.get(pane) === sig) continue
    if (pendingQuestions.get(pane) !== sig) {
      pendingQuestions.set(pane, sig)
      continue
    }
    shownQuestions.set(pane, sig)
    d.log(`session ${s.id}: a question on the screen, sent to its chat`)
    await warnQuestion(d, s, pane)
  }
}

async function warnQuestion(d: Daemon, s: Session, pane: string): Promise<void> {
  const c = s.lastChat ?? sessionTarget(d, s)
  if (!c) return
  await inChat(d, c.chatId, c.threadId, async () => {
    // The point first: a chat reader sees the question, then the screen.
    const v = await screenView(d, `p${pane.slice(1)}`)
    const text = `${tr('❓ Сессия #{id} ждёт ответа на экране. Пока вопрос открыт, она не берёт сообщения — ответьте клавишами.', { id: s.id })}\n\n${v.text}`
    await d.bot.api.sendMessage(c.chatId, text, { parse_mode: 'HTML', reply_markup: v.kb, ...(c.threadId ? { message_thread_id: c.threadId } : {}) })
  }).catch(err => d.log(`question notice failed: ${err}`))
}

/** wd:re / wd:rs:<session> — close a session (with the /exit checks) and start it again with its conversation; stuck — it did not take a message. */
async function restartStuck(d: Daemon, ctx: Context, id: string, answer: (t?: string) => Promise<unknown>, stuck = true): Promise<void> {
  const s = d.sessions.get(id)
  if (!s) { await answer(tr('Сессия уже отключилась.')); return }
  if (!endSession(d, s)) { await answer(tr('Сессия не в tmux — перезапустите её сами.')); return }
  await answer(tr('♻️ Перезапускаю'))
  const edit = (text: string, kb?: InlineKeyboard) => ctx.editMessageText(text, { parse_mode: 'HTML', ...(kb ? { reply_markup: kb } : {}) }).catch(() => {})
  await edit(tr('♻️ Закрываю сессию #{id}…', { id }))
  if (!(await waitGone(d, id, endTiming.checkMs * 2 + 10_000))) {
    d.ending.delete(id)
    await edit(tr('❌ Сессия #{id} не закрылась ни по /exit, ни по Ctrl-C, ни по SIGTERM. Посмотрите окно в tmux.', { id }))
    return
  }
  // The same CLI as before: the conversation id is that engine's (a Codex thread cannot be resumed by Claude Code).
  const o = { engine: s.engine, resume: s.claude.sessionId ?? undefined, continue: !s.claude.sessionId, name: sessionName(d, s.projectKey, s.engine) }
  const l = await launchOnce(d, s.cwd, o)
  if (!l.ok) {
    await edit(l.skipped ? tr('⏳ Сессия уже запускается.') : tr('❌ Не удалось запустить: {v}', { v: escapeHtml(l.error) }))
    return
  }
  // Nothing to confirm: the startup questions are answered here; the journal keeps where it runs.
  await edit(tr('♻️ Перезапускаю сессию #{id} с тем же разговором…', { id }), new InlineKeyboard())
  void sendNotice(d, 'sessions', () => tr('♻️ Сессия #{id} ({v}) перезапущена из Telegram: окно {v2}.', { id, v: escapeHtml(projectTitle(s)), v2: escapeHtml(attachTarget(l.window)) }))
  // The notice follows the launch: the startup questions are answered here, and the message says when it is in.
  // In the background: a launch takes up to a couple of minutes, the bot keeps handling updates meanwhile.
  void awaitConnect(d, s.cwd, l.window, { confirm: true }).then(async r => {
  if (r.ok) await edit(tr('✅ Сессия #{id} перезапущена и подключилась — можно писать.', { id: r.session.id }) + (stuck ? `\n${tr('Сообщение, которое она не взяла, повторите.')}` : ''), new InlineKeyboard())
  else await edit(tr('⚠️ Сессия в окне {v} не подключилась: {why}. Посмотрите экран.', { v: escapeHtml(attachTarget(l.window)), why: r.reason === 'gone' ? tr('окно закрылось') : r.reason === 'stuck' ? tr('на экране вопрос, на который я не отвечаю сам') : tr('не подключилась за {n} с', { n: Math.round(r.ms / 1000) }) }), screenKb(l.window))
  }).catch(err => d.log(`restart of ${id}: waiting for the connection failed: ${err}`))
}

/**
 * wd:run:<id> — restart a stopped session; wd:topic:<thread> — start a waiting
 * topic's session; wd:re:<session> — restart a session that does not answer,
 * wd:rs:<session> — the same from its card («♻️ Перезапустить»)
 * (all owner only); wd:ask:<id> — a member asks the owner to restart their
 * own session.
 */
export async function handleWatchdogCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^wd:(run|topic|ask|re|rs):([0-9a-f]+|\d+)$/.exec(data)
  if (!m) return false
  const answer = (t?: string) => ctx.answerCallbackQuery(t ? { text: t } : undefined).catch(() => {})
  if (!ctx.from || !can(ctx.from.id, m[1] === 'ask' ? 'write' : 'control')) {
    await answer(tr('Нет доступа.'))
    return true
  }
  if (m[1] === 're' || m[1] === 'rs') {
    await restartStuck(d, ctx, m[2], answer, m[1] === 're')
    return true
  }
  if (m[1] === 'topic') {
    const pressedIn = String(ctx.callbackQuery?.message?.chat.id ?? '')
    const chat = d.isTopicsChat(pressedIn) ? pressedIn : d.topicsChatId
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
  if (m[1] === 'ask') {
    // A user's request waits for the owner: their DM.
    const out = owner()
    if (String(ctx.from.id) !== r.user || !out) { await answer(tr('Нет доступа.')); return true }
    const req = await d.bot.api.sendMessage(out, inChat(d, out, undefined, () => ownerNotice(r, tr('🙋 {v} просит перезапустить свою сессию.', { v: escapeHtml(r.name) }))), { parse_mode: 'HTML', reply_markup: inChat(d, out, undefined, () => runKb(m[2])) })
    d.store.set(`wd:${m[2]}`, JSON.stringify({ ...r, sent: [...(r.sent ?? []), { chat: out, id: req.message_id }] }))
    await answer(tr('🙋 Запрос отправлен'))
    await ctx.editMessageText(tr('⚠️ Ваша сессия остановилась.\n🙋 Запрос на перезапуск отправлен владельцу бота. Сообщения, которые вы напишете, дойдут, когда она подключится.'), { parse_mode: 'HTML' }).catch(() => {})
    return true
  }
  try {
    const o = { ...(r.engine ? { engine: r.engine } : {}), resume: r.resume ?? undefined, continue: !r.resume, name: sessionName(d, r.dir, r.engine) ?? r.session }
    // The same lock as a message in the project topic: two launches at once left a second window waiting on the prompt.
    const l = await launchOnce(d, r.dir, o)
    if (!l.ok && l.skipped) { await answer(tr('⏳ Сессия уже запускается.')); return true }
    if (!l.ok) throw new Error(l.error)
    const win = l.window
    // The other notices about it (the member's, a request) go; this one turns into the launch message.
    const here = ctx.callbackQuery?.message
    await dropStale(d, r.dir, here ? { chat: String(here.chat.id), id: here.message_id } : undefined)
    await answer(tr('🚀 Запускаю'))
    await ctx.editMessageText(tr('🚀 Запускаю <b>{v}</b> — сообщения дойдут, когда она подключится.', { v: escapeHtml(r.name) }), { parse_mode: 'HTML', reply_markup: new InlineKeyboard() }).catch(() => {})
    void sendNotice(d, 'sessions', () => tr('🚀 Запуск <b>{v}</b>: окно {v2}\n<code>{v3}</code>', { v: escapeHtml(r.name), v2: escapeHtml(attachTarget(win)), v3: escapeHtml(launchCommand(o)) }))
  } catch (err) {
    await answer(tr('Не удалось: {v}', { v: String(err instanceof Error ? err.message : err) }).slice(0, 190))
  }
  return true
}
