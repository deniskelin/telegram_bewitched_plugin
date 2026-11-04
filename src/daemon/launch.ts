/**
 * New Claude Code sessions from Telegram: a topic created by the owner (or
 * /new_session) becomes a project dir under PROJECTS_DIR, and a session is
 * started there in a new tmux window. The development-channels confirmation
 * screen is left for the user to accept — it is a human-in-the-loop check.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { execFile } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import { can, owner } from '../access.ts'
import { settings, STATE_DIR } from '../config.ts'
import { escapeHtml } from '../format.ts'
import { cmdlineOf } from '../proc.ts'
import type { Daemon, Session } from './daemon.ts'
import { inChat, inSession } from './lang.ts'
import { confirmLaunch, isQuestion, isStartupPrompt } from './screen.ts'
import { engineOf, lastConversation, projectEngine, type EngineId } from './engines.ts'
import { button } from './stream.ts'
import { projectTranscriptDir } from './transcript.ts'
import { sendNotice } from './journal.ts'
import { idleKind, idleMin, idleName } from './idle.ts'
import { autoResume, clearIdle, logSuspended, markIdle } from './autoresume.ts'
import { t as tr } from '../i18n/index.ts'

/** Folder name from a topic name: letters/digits (any script), dot, dash, underscore. */
export function slugify(name: string): string {
  return name
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/^[.-]+/, '')
    .slice(0, 64)
}

/** Absolute project path for a name or path; refuses anything outside PROJECTS_DIR unless absolute. */
export function projectPath(arg: string): string | null {
  const raw = arg.trim()
  if (!raw) return null
  if (isAbsolute(raw) || raw.startsWith('~/')) {
    const p = resolve(raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw)
    return p.includes('\0') ? null : p
  }
  const slug = slugify(raw)
  return slug ? join(settings.projectsDir, slug) : null
}

function run(args: string[]): Promise<string> {
  return new Promise((res, rej) => execFile('tmux', args, { timeout: 5000 }, (err, out) => (err ? rej(err) : res(String(out).trim()))))
}

/**
 * Start `claude` in `dir`. A named session (a user's or a project's) gets a
 * tmux session of its own with that name, so `tmux ls` shows what is what;
 * the main one gets a window in TMUX_SESSION. Returns the window: an index in
 * TMUX_SESSION, or <session>:<index> for an own session. The command line
 * comes from settings, never from chat input; the dir is passed as an
 * argument, not through a shell.
 */
/** engine and model: the project's choice (engines.ts), filled in by Daemon.launchSession. */
export type LaunchOptions = {
  continue?: boolean; resume?: string; name?: string; engine?: EngineId; model?: string
  /** Reasoning effort, one of the engine's efforts (checked again when the command is built). */
  effort?: string
  /** FR-20: the topic's prompt mode (promptmode.ts): a system prompt file and tools taken away. */
  prompt?: { file: string; disallowed: string[]; readOnly: boolean; key: string }
}

/** The engine's command line: for Claude Code, CLAUDE_LAUNCH_CMD plus -n, --model, --resume / --continue. */
export function launchCommand(o: LaunchOptions = {}): string {
  return engineOf(o.engine).launchCommand(o)
}

/**
 * Name for the Claude session (-n), its tmux session and window, after its
 * folder, as the folders are named by ids: claude-user-<telegram id> for a
 * user's session, claude-project-<group id>-<topic id> for a project
 * (claude-project-<folder> for one made by hand); codex-… for a project on
 * Codex. Undefined for the main session: it keeps the folder name and lives
 * in TMUX_SESSION.
 */
export function sessionName(d: Daemon, dir: string, engine: EngineId = projectEngine(d, dir).engine): string | undefined {
  // The engine first: a Codex session is codex-user-…, codex-project-… — its own tmux session, window :0.
  const prefix = engine === 'claude' ? 'claude' : engine
  const user = /^(\d+)$/.exec(relative(settings.usersDir, dir))?.[1]
  // The Telegram id: always there and never changes, unlike a username.
  if (user) return `${prefix}-user-${user}`
  const slug = slugify(basename(dir))
  return slug ? `${prefix}-project-${slug}` : undefined
}

/**
 * FR-19: where a launched agent's exit code is written when it exits. 0 is a
 * normal exit (/exit or /quit typed in the terminal), anything else a crash or
 * a kill (137: OOM). The watchdog reads it: from outside the two look alike.
 */
export function exitCodeFile(dir: string): string {
  return join(STATE_DIR, 'exits', `${createHash('sha1').update(dir).digest('hex').slice(0, 16)}.code`)
}

/** The exit code a session in dir left since `since` (ms), or null. */
export function exitCodeSince(dir: string, since: number): number | null {
  try {
    const f = exitCodeFile(dir)
    if (statSync(f).mtimeMs < since - 1000) return null
    const v = readFileSync(f, 'utf8').trim()
    return /^\d+$/.test(v) ? Number(v) : null
  } catch {
    return null
  }
}

/** The launch command, followed by writing its exit code (the window still closes with it). */
export function withExitCode(cmd: string, dir: string): string {
  const f = exitCodeFile(dir)
  try { mkdirSync(join(STATE_DIR, 'exits'), { recursive: true, mode: 0o700 }) } catch {}
  return `${cmd}; printf %s "$?" > '${f.replace(/'/g, "'\\''")}'`
}

export async function tmuxLaunch(dir: string, o: LaunchOptions = {}): Promise<string> {
  const cmd = withExitCode(launchCommand(o), dir)
  if (o.name && /^[\p{L}\p{N}._-]+$/u.test(o.name)) {
    const own = o.name
    if (await run(['has-session', '-t', `=${own}`]).then(() => true, () => false)) {
      return `${own}:${await run(['new-window', '-d', '-P', '-F', '#{window_index}', '-t', `=${own}:`, '-n', own, '-c', dir, cmd])}`
    }
    await run(['new-session', '-d', '-s', own, '-n', own, '-c', dir, cmd])
    return `${own}:${await run(['display-message', '-p', '-t', `=${own}:`, '#{window_index}']).catch(() => '0')}`
  }
  const sess = settings.tmuxSession
  const name = slugify(basename(dir)) || 'claude'
  const hasSession = await run(['has-session', '-t', sess]).then(() => true, () => false)
  if (!hasSession) {
    await run(['new-session', '-d', '-s', sess, '-n', name, '-c', dir, cmd])
    return '0'
  }
  return run(['new-window', '-d', '-P', '-F', '#{window_index}', '-t', `${sess}:`, '-n', name, '-c', dir, cmd])
}

/** tail: the last visible lines of the pane (Claude's status line is there). */
export type TmuxLocation = { session: string; window: string; windowName: string; pane: string; tail: string }

/** Session, window and pane of a tmux pane id — what you need to attach from a terminal. */
export async function tmuxLocation(pane: string): Promise<TmuxLocation | null> {
  try {
    const out = await run(['display-message', '-p', '-t', pane, '#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}'])
    const [session, window, windowName, idx] = out.split('\t')
    if (!session) return null
    const tail = await run(['capture-pane', '-p', '-t', pane]).catch(() => '')
    return { session, window, windowName, pane: idx, tail }
  } catch {
    return null
  }
}

async function say(d: Daemon, chatId: string, threadId: number | undefined, html: string, kb?: InlineKeyboard): Promise<void> {
  await d.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', ...(threadId != null ? { message_thread_id: threadId } : {}), ...(kb ? { reply_markup: kb } : {}) })
    .catch(err => d.log(`launch notice failed: ${err}`))
}

/** tmux capture of a pane or window; null when it is gone. Replaced in tests via Daemon. */
export function tmuxCapture(target: string): Promise<string | null> {
  return run(['capture-pane', '-p', '-t', target]).catch(() => null)
}

/** The TUI did not take a typed line (a question was open, or the text never showed up); nothing was confirmed. */
export class InputBlocked extends Error {
  constructor(readonly screen: string) {
    super('the session did not take the input')
  }
}

/** The text in the input line — after ❯ (Claude Code) or › (Codex), wrapped lines included; spaces are ignored. */
export function inputShows(screen: string, text: string): boolean {
  const lines = screen.split('\n')
  const at = lines.findLastIndex(l => /^\s*[❯›]/.test(l))
  if (at < 0) return false
  const box: string[] = []
  for (const l of lines.slice(at, at + 4)) {
    if (box.length && /^[\s─━]*$/.test(l)) break
    box.push(l)
  }
  const squash = (s: string) => s.replace(/\s+/g, '')
  const shown = box.join('')
  // A paste longer than 1000 characters Codex folds into «[Pasted Content N chars]», N exact.
  const len = [...text].length
  if ([...shown.matchAll(/\[Pasted Content (\d+) chars\]/g)].some(m => Math.abs(Number(m[1]) - len) <= 2)) return true
  // The first line is enough: the box ends at a blank line, a message may have one.
  const first = squash(text.split('\n').find(l => l.trim()) ?? text)
  return squash(shown).includes(first.slice(0, 40))
}

type TypeIo = { run: (args: string[]) => Promise<string>; capture: (target: string) => Promise<string | null>; sleep: (ms: number) => Promise<void> }
const typeIo: TypeIo = { run, capture: target => tmuxCapture(target), sleep: ms => Bun.sleep(ms) }

/** paste: as one bracketed paste (tmux paste-buffer -p) — newlines stay and do not send it early; for text, not keys. */
export type TypeOptions = { paste?: boolean }

/**
 * Put text into a pane as one bracketed paste. It goes through a file:
 * set-buffer refuses a long argument («command too long»), load-buffer reads
 * any size. The file is private and removed right away.
 */
async function pasteText(io: TypeIo, target: string, text: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bewitched-paste-'))
  const file = join(dir, 'text')
  const buf = `bewitched-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(file, text, { mode: 0o600 })
    await io.run(['load-buffer', '-b', buf, file])
    await io.run(['paste-buffer', '-p', '-d', '-b', buf, '-t', target])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Type a line into a session and press Enter — only once it is seen in the
 * input line (FR-14). An open question (a menu, a confirmation) takes keys as
 * answers: Enter approves whatever is selected (a command, a model switch),
 * digits pick options. So nothing is typed while one is on the screen, and
 * Enter goes only after the text shows up after ❯; otherwise InputBlocked
 * with the screen.
 */
export async function tmuxType(target: string, text: string, io: TypeIo = typeIo, o: TypeOptions = {}): Promise<void> {
  const before = (await io.capture(target)) ?? ''
  if (isQuestion(before)) throw new InputBlocked(before)
  if (o.paste) await pasteText(io, target, text)
  else await io.run(['send-keys', '-t', target, '-l', text])
  let screen = ''
  for (let i = 0; i < 4; i++) {
    await io.sleep(250)
    screen = (await io.capture(target)) ?? ''
    if (inputShows(screen, text)) {
      await io.run(['send-keys', '-t', target, 'Enter'])
      return
    }
  }
  throw new InputBlocked(screen)
}

/** The pane id (%N) of a window; null when it is gone. Replaced in tests via Daemon. */
export function tmuxPaneId(target: string): Promise<string | null> {
  return run(['display-message', '-p', '-t', target, '#{pane_id}']).then(id => id || null, () => null)
}

/** Close a tmux window (by pane id or session:window); the processes in it end. */
export async function tmuxKillWindow(target: string): Promise<void> {
  await run(['kill-window', '-t', target])
}

/** Press keys in a pane or window (tmux key names, e.g. Enter, Escape, 1). */
export async function tmuxKeys(target: string, keys: string[]): Promise<void> {
  for (const k of keys) await run(['send-keys', '-t', target, k])
}

/** How long a session gets to disconnect after /exit, and again after Ctrl-C. Replaced in tests. */
export const endTiming = { checkMs: 20_000 }

/**
 * End a Claude Code session from outside: interrupt the current turn, then
 * type /exit into its tmux pane. Returns false when the session isn't in tmux.
 * The end is checked: a session still connected after endTiming.checkMs gets
 * Ctrl-C twice, then SIGTERM (ensureEnded).
 */
export function endSession(d: Daemon, s: { id: string; tmuxPane: string | null; claudePid?: number | null; engine?: EngineId }): boolean {
  if (!s.tmuxPane) return false
  d.ending.add(s.id) // planned: the watchdog stays quiet
  const pane = s.tmuxPane
  void (async () => {
    await d.tmuxKeys(pane, ['Escape'])
    await Bun.sleep(700)
    try {
      await d.tmuxType(pane, engineOf(s.engine).exitCommand)
    } catch (err) {
      if (!(err instanceof InputBlocked)) throw err
      // A question took the input: /exit was not typed into it; Ctrl-C closes it and exits (Claude Code and Codex alike).
      d.log(`end session ${s.id}: /exit not taken (a question on the screen?), pressing Ctrl-C`)
      await d.tmuxKeys(pane, ['C-c'])
      await Bun.sleep(500)
      await d.tmuxKeys(pane, ['C-c'])
    }
  })().catch(err => d.log(`end session ${s.id}: ${err instanceof Error ? err.message : err}`))
  setTimeout(() => void ensureEnded(d, s.id, pane, s.claudePid ?? null).catch(err => d.log(`end session ${s.id}: ${err}`)), endTiming.checkMs).unref?.()
  return true
}

/**
 * /exit did not close the session — an Escape opened a menu, a dialog was up
 * (2026-10-31: a project session stayed connected for a day after it was
 * "suspended"). Its screen goes to the log; Ctrl-C twice closes what is open
 * and exits Claude Code; if it is still connected, SIGTERM — only to a
 * process that is Claude's.
 */
async function ensureEnded(d: Daemon, id: string, pane: string, pid: number | null): Promise<void> {
  if (!d.sessions.has(id)) return
  const screen = (await d.tmuxCapture(pane)) ?? ''
  d.log(`end session ${id}: still connected after /exit, pressing Ctrl-C; screen:\n${screen.split('\n').filter(l => l.trim()).slice(-12).join('\n')}`)
  await d.tmuxKeys(pane, ['C-c'])
  await Bun.sleep(500)
  await d.tmuxKeys(pane, ['C-c'])
  await Bun.sleep(endTiming.checkMs)
  if (!d.sessions.has(id)) return
  if (pid == null || !cmdlineOf(pid).some(a => basename(a) === 'claude' || a.includes('claude-code'))) {
    d.log(`end session ${id}: still connected after Ctrl-C, no Claude process to stop (pid ${pid})`)
    return
  }
  d.log(`end session ${id}: still connected after Ctrl-C, SIGTERM ${pid}`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    d.log(`end session ${id}: SIGTERM ${pid} failed: ${err}`)
  }
}

/** Wait until a session disconnects; false if it is still there after ms. */
export async function waitGone(d: Daemon, id: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (d.sessions.has(id) && Date.now() < until) await Bun.sleep(250)
  return !d.sessions.has(id)
}

// --------------------------------------------------------------------------
// A launch nobody confirmed: remind the owner
// --------------------------------------------------------------------------

/**
 * A launched session that hasn't connected after LAUNCH_REMIND_SEC (and again
 * after 5× that) is most likely waiting on the development-channels prompt:
 * the owner gets a reminder with «✅ Подтвердить запуск»; a user whose own
 * session it is hears once that it is being confirmed. Nothing is pressed.
 */
export function watchLaunch(d: Daemon, dir: string, win: string): void {
  const sec = settings.launchRemindSec
  if (sec <= 0) return
  for (const [i, after] of [sec, sec * 5].entries()) {
    setTimeout(() => void remindLaunch(d, dir, win, i === 0).catch(err => d.log(`launch reminder failed: ${err}`)), after * 1000).unref?.()
  }
}

/**
 * Launch reminders of a dir, under lr:<hash of dir>: off — the owner said
 * «🔕 Не напоминать» (kept until «🔔 Напоминать»); sent — the reminders in the
 * owner's DM, deleted once the session connects.
 */
type RemindState = { dir: string; off?: boolean; sent?: { chat: string; id: number }[] }

function remindKey(dir: string): string {
  return createHash('sha1').update(dir).digest('hex').slice(0, 10)
}

function remindState(d: Daemon, key: string): RemindState | null {
  try { return JSON.parse(d.store.get(`lr:${key}`) ?? '') as RemindState } catch { return null }
}

export async function remindLaunch(d: Daemon, dir: string, win: string, first: boolean): Promise<void> {
  if (d.activeSessions().some(s => s.cwd === dir)) return
  const raw = await d.tmuxCapture(windowTarget(win))
  const o = owner()
  if (raw == null || !o) return // the window is gone: the watchdog or a failed start has said so
  const user = /^(\d+)$/.exec(relative(settings.usersDir, dir))?.[1]
  const key = remindKey(dir)
  const st = remindState(d, key) ?? { dir }
  if (!st.off) {
    const who = user ? `👤 ${d.userLabel(user)}` : `📂 ${basename(dir)}`
    // A launch waiting for the owner: their DM, not the journal.
    const out = o
    const text = inChat(d, out, undefined, () => isStartupPrompt(raw)
      ? tr('⏳ Сессия <b>{v}</b> (окно {v2}) ждёт подтверждения запуска — пока его нет, сообщения до неё не дойдут.', { v: escapeHtml(who), v2: escapeHtml(attachTarget(win)) })
      : tr('⏳ Сессия <b>{v}</b> (окно {v2}) запущена, но так и не подключилась. Посмотрите, что на экране.', { v: escapeHtml(who), v2: escapeHtml(attachTarget(win)) }))
    const kb = inChat(d, out, undefined, () => screenKb(win).row(button(tr('🔕 Не напоминать'), `lr:off:${key}`)))
    const m = await d.bot.api.sendMessage(out, text, { parse_mode: 'HTML', reply_markup: kb }).catch(err => { d.log(`launch notice failed: ${err}`); return null })
    if (m) d.store.set(`lr:${key}`, JSON.stringify({ ...st, sent: [...(st.sent ?? []), { chat: out, id: m.message_id }] }))
  }
  if (first && user && user !== o) await say(d, user, undefined, inChat(d, user, undefined, () => tr('⏳ Вашу сессию ещё подтверждают на сервере — сообщение не потеряется и дойдёт, как только она подключится.')))
}

/** The session connected: its launch reminders are done with (🔕 stays). */
export function onLaunchConnected(d: Daemon, dir: string): void {
  const key = remindKey(dir)
  const st = remindState(d, key)
  if (!st?.sent?.length) return
  for (const m of st.sent) void d.bot.api.deleteMessage(m.chat, m.id).catch(() => {})
  d.store.set(`lr:${key}`, st.off ? JSON.stringify({ dir: st.dir, off: true }) : null)
}

/** lr:off:<key> — no more launch reminders for that dir; lr:on:<key> — again. Owner only. */
async function handleRemindCallback(d: Daemon, ctx: Context, m: RegExpExecArray): Promise<void> {
  const st = remindState(d, m[2])
  if (!st) { await ctx.answerCallbackQuery({ text: tr('Уже неактуально.') }).catch(() => {}); return }
  const here = ctx.callbackQuery?.message
  if (m[1] === 'off') {
    // The other reminders go; this one says they are off, with a way back.
    for (const s of st.sent ?? []) if (!here || s.id !== here.message_id) void d.bot.api.deleteMessage(s.chat, s.id).catch(() => {})
    d.store.set(`lr:${m[2]}`, JSON.stringify({ dir: st.dir, off: true, sent: here ? [{ chat: String(here.chat.id), id: here.message_id }] : [] }))
    await ctx.answerCallbackQuery({ text: tr('🔕 Больше не напомню') }).catch(() => {})
    await ctx.editMessageText(tr('🔕 Напоминания о запуске <code>{v}</code> отключены.', { v: escapeHtml(st.dir) }), { parse_mode: 'HTML', reply_markup: new InlineKeyboard([[button(tr('🔔 Напоминать'), `lr:on:${m[2]}`)]]) }).catch(() => {})
    return
  }
  d.store.set(`lr:${m[2]}`, JSON.stringify({ ...st, off: false }))
  await ctx.answerCallbackQuery({ text: tr('🔔 Напоминания включены') }).catch(() => {})
  await ctx.editMessageText(tr('🔔 Напоминания о запуске <code>{v}</code> включены.', { v: escapeHtml(st.dir) }), { parse_mode: 'HTML' }).catch(() => {})
}

// --------------------------------------------------------------------------
// Sessions on demand: a user's DM session, a project topic without a session
// --------------------------------------------------------------------------

const RELAUNCH_MS = 10 * 60_000

type Launch = { ok: true; window: string } | { ok: false; skipped: boolean; error: string; window?: string }

/**
 * Launch once per dir until that session connects: while RELAUNCH_MS has not
 * passed, or for as long as the launched window lives (FR-19 — it may wait on
 * a question for an hour; a second launch only left a second window waiting).
 */
export async function launchOnce(d: Daemon, dir: string, o: LaunchOptions, remind = true): Promise<Launch> {
  const at = d.launching.get(dir)
  if (at && (Date.now() - at < RELAUNCH_MS || await launchAlive(d, dir))) {
    d.log(`launch ${dir}: skipped, a launch is under way (window ${d.launchWindows.get(dir) ?? '?'})`)
    return { ok: false, skipped: true, error: '', window: d.launchWindows.get(dir) }
  }
  d.launching.set(dir, Date.now())
  try {
    const window = await d.launchSession(dir, o)
    d.log(`launch ${dir}: window ${window}, ${describeLaunch(d, dir, o)}`)
    noteLaunch(d, dir, window, remind)
    return { ok: true, window }
  } catch (err) {
    d.launching.delete(dir)
    d.log(`launch ${dir}: failed: ${err instanceof Error ? err.message : err}`)
    return { ok: false, skipped: false, error: String(err instanceof Error ? err.message : err) }
  }
}

/** For the log: engine, model, name and which conversation a launch continues. */
function describeLaunch(d: Daemon, dir: string, o: LaunchOptions): string {
  const e = o.engine ?? projectEngine(d, dir).engine
  const model = o.model ?? projectEngine(d, dir).model
  return `${e}${model ? `/${model}` : ''} name=${o.name ?? '-'} ${o.resume ? `resume ${o.resume}` : o.continue ? 'continue' : 'new conversation'}`
}

/** A launch of dir is under way in this window: the lock, and (unless the daemon watches it itself) the reminders. */
export function noteLaunch(d: Daemon, dir: string, window: string, remind = true): void {
  d.launching.set(dir, Date.now())
  d.launchWindows.set(dir, window)
  if (remind) watchLaunch(d, dir, window)
}

/**
 * Which conversation a new start of dir on an engine continues: the last one
 * the hooks reported for it, else --continue for Claude when the folder has
 * transcripts; nothing — a new one.
 */
export function continueOptions(d: Daemon, dir: string, engine: EngineId): Pick<LaunchOptions, 'resume' | 'continue'> {
  const id = lastConversation(d, engine, dir)
  if (id) return { resume: id }
  return engine === 'claude' && hasTranscripts(dir) ? { continue: true } : {}
}

/** How long a launch gets to connect when the daemon waits for it itself. Replaced in tests. */
export const connectTiming = { ms: 120_000, pollMs: 1000, windowGoneMs: 8000 }

export type Connect = { ok: true; session: Session; ms: number } | { ok: false; reason: 'gone' | 'timeout' | 'stuck'; screen: string; ms: number }

/**
 * Wait until the session launched into win connects. confirm: the startup
 * questions of Claude Code (trust the folder, development channels) are
 * answered here — only for launches the owner asked for or allowed (a
 * switch, ♻️, an idle wake-up). Anything else on the screen is left alone:
 * the question watch shows it to the chat.
 */
export async function awaitConnect(d: Daemon, dir: string, win: string, o: { confirm: boolean }): Promise<Connect> {
  const started = Date.now()
  const target = windowTarget(win)
  let raw = ''
  while (Date.now() - started < connectTiming.ms) {
    const s = d.activeSessions().find(x => x.cwd === dir || x.projectKey === dir)
    if (s) return { ok: true, session: s, ms: Date.now() - started }
    const cap = await d.tmuxCapture(target)
    if (cap == null) {
      d.log(`launch ${dir}: window ${win} closed before the session connected`)
      return { ok: false, reason: 'gone', screen: raw, ms: Date.now() - started }
    }
    raw = cap
    if (o.confirm && isStartupPrompt(raw)) {
      d.log(`launch ${dir}: confirming the startup prompt in ${win}`)
      const r = await confirmLaunch(d, target)
      if (r.result === 'connected') {
        const s = d.sessions.get(r.sessionId)
        if (s) return { ok: true, session: s, ms: Date.now() - started }
      }
      if (r.result === 'stuck') return { ok: false, reason: 'stuck', screen: (await d.tmuxCapture(target)) ?? raw, ms: Date.now() - started }
      continue
    }
    await Bun.sleep(connectTiming.pollMs)
  }
  d.log(`launch ${dir}: no connection after ${Date.now() - started} ms; screen:\n${raw.split('\n').filter(l => l.trim()).slice(-8).map(l => `  | ${l.trimEnd()}`).join('\n')}`)
  return { ok: false, reason: 'timeout', screen: raw, ms: Date.now() - started }
}

/**
 * The window of a session that has disconnected: give its process a few
 * seconds to exit, then close the window — a new start of the same name
 * opens window :0 of a fresh tmux session instead of :1 next to a leftover.
 */
export async function closeWindow(d: Daemon, pane: string | null): Promise<void> {
  if (!pane || !/^%\d+$/.test(pane)) return
  const until = Date.now() + connectTiming.windowGoneMs
  while (Date.now() < until) {
    if ((await d.tmuxPaneId(pane)) == null) return
    await Bun.sleep(250)
  }
  d.log(`window of pane ${pane} still open after its session ended, closing it`)
  await d.tmuxKillWindow(pane).catch(err => d.log(`kill-window ${pane} failed: ${err}`))
}

/** The window of dir's pending launch is still there. */
async function launchAlive(d: Daemon, dir: string): Promise<boolean> {
  const win = d.launchWindows.get(dir)
  return win != null && (await d.tmuxPaneId(windowTarget(win))) != null
}

function hasTranscripts(dir: string): boolean {
  try {
    return readdirSync(projectTranscriptDir(dir)).some(f => f.endsWith('.jsonl'))
  } catch {
    return false
  }
}

/** The tmux target of a launched window: 3 → TMUX_SESSION:3, claude-user-1:0 as is. */
export function windowTarget(win: string): string {
  return /^\d+$/.test(win) ? `${settings.tmuxSession}:${win}` : win
}

/** What to type after `tmux attach -t`: an own session by its name alone. */
export function attachTarget(win: string): string {
  const m = /^(.+):0$/.exec(win)
  return m && m[1] !== settings.tmuxSession ? m[1] : windowTarget(win)
}

export function confirmHint(win: string): string {
  return tr('<pre>tmux attach -t {v}</pre>и примите экран подтверждения каналов. Или кнопкой «✅ Подтвердить запуск» — прямо из Telegram.', { v: escapeHtml(attachTarget(win)) })
}

/** Screen code of a window for callback data (see screen.ts tmuxTarget): w3, or s<session>.<index>. */
export function windowCode(win: string): string {
  return /^\d+$/.test(win) ? `w${win}` : `s${win.replace(/:(\d+)$/, '.$1')}`
}

/** "👁 Экран" for a freshly launched window: its screen with keys to accept the channels prompt. */
export function screenKb(win: string): InlineKeyboard {
  const code = windowCode(win)
  return new InlineKeyboard([[button(tr('✅ Подтвердить запуск'), `tx:${code}:c`, 'success'), button(tr('👁 Экран и клавиши'), `tx:${code}`, 'primary')]])
}

export function manualCmd(dir: string, o: LaunchOptions = {}): string {
  return `<pre>cd ${escapeHtml(dir)} &amp;&amp; ${escapeHtml(launchCommand(o))}</pre>`
}

/**
 * A DM from a user whose session is not running: start it in USERS_DIR/<id>
 * (continuing the last conversation there). The message is already queued.
 */
export async function launchUserSession(d: Daemon, userId: string, name: string, where: { chatId: string; threadId?: number } = { chatId: userId }): Promise<void> {
  const dir = join(settings.usersDir, userId)
  mkdirSync(dir, { recursive: true })
  // Suspended for idling: it wakes up by itself, the chat hears nothing (autoresume.ts).
  if (await autoResume(d, dir, name, where)) return
  // The last conversation of the engine it starts on (a Codex thread, or Claude's --continue).
  const conv = continueOptions(d, dir, projectEngine(d, dir).engine)
  const r = await launchOnce(d, dir, { ...conv, name: sessionName(d, dir) })
  const o = owner()
  if (!r.ok && r.skipped) {
    await say(d, where.chatId, where.threadId, tr('⏳ Ваша сессия уже запускается — сообщение дойдёт, как только она подключится.'))
    return
  }
  if (!r.ok) {
    await say(d, where.chatId, where.threadId, o === userId
      ? tr('❌ Не удалось запустить вашу сессию: {v}\nСообщение сохранено. Запустить вручную:{v2}', { v: escapeHtml(r.error), v2: manualCmd(dir, { ...conv, name: sessionName(d, dir) }) })
      : tr('❌ Не удалось запустить вашу сессию: {v}\nСообщение сохранено, владелец бота получил уведомление.', { v: escapeHtml(r.error) }))
    if (o !== userId) await sendNotice(d, 'sessions', () => tr('❌ Не удалось запустить сессию пользователя {v} ({userId}): {v2}{v3}', { v: escapeHtml(name), userId, v2: escapeHtml(r.error), v3: manualCmd(dir, { ...conv, name: sessionName(d, dir) }) }))
    return
  }
  const self = o === userId
  await say(d, where.chatId, where.threadId, self
    ? tr('🚀 Запускаю вашу сессию в tmux (окно {v}). Сообщение дойдёт, когда она подключится. Подтвердите запуск:{v2}', { v: escapeHtml(attachTarget(r.window)), v2: confirmHint(r.window) })
    : tr('🚀 Запускаю вашу сессию. Сообщение дойдёт, когда она подключится — запуск подтверждают на сервере, это может занять время.'), self ? screenKb(r.window) : undefined)
  if (o && !self) {
    // The launch waits for the owner's confirmation: their DM.
    await say(d, o, undefined, inChat(d, o, undefined, () => tr('🚀 {v} ({userId}) написал(а) боту — запускаю сессию пользователя в <code>{v2}</code>. Подтвердите:{v3}', { v: escapeHtml(name), userId, v2: escapeHtml(dir), v3: confirmHint(r.window) })), inChat(d, o, undefined, () => screenKb(r.window)))
  }
}

/**
 * A message in a project topic without a session: start the project's
 * session. If that fails, post the manual command and close the topic until
 * the session connects (ensureTopic reopens it).
 */
export async function launchForTopic(d: Daemon, chatId: string, threadId: number, projectKey: string, from = ''): Promise<void> {
  const launchable = !projectKey.includes('#') && existsSync(projectKey)
  // Suspended for idling: it wakes up by itself, the chat hears nothing (autoresume.ts).
  if (launchable && await autoResume(d, projectKey, from, { chatId, threadId })) return
  const r: Launch = launchable ? await launchOnce(d, projectKey, { name: sessionName(d, projectKey) }) : { ok: false, skipped: false, error: tr('папки проекта нет') }
  if (!r.ok && r.skipped) {
    await say(d, chatId, threadId, tr('⏳ Сессия проекта уже запускается — сообщение в очереди.'), r.window ? screenKb(r.window) : undefined)
    return
  }
  if (r.ok) {
    await say(d, chatId, threadId, tr('🚀 Запускаю сессию проекта в tmux (окно {v}). Сообщение дойдёт, когда она подключится. Подтвердите запуск:{v2}', { v: escapeHtml(attachTarget(r.window)), v2: confirmHint(r.window) }), screenKb(r.window))
    return
  }
  // The topic is seen by everyone: the error there, the command only in the owner's DM.
  const dir = projectKey.replace(/#.*$/, '')
  await say(d, chatId, threadId, tr('❌ Не удалось запустить сессию проекта: {v}\nСообщение сохранено. Топик закрыт, пока сессия не подключится.', { v: escapeHtml(r.error) }))
  await sendNotice(d, 'sessions', () => tr('❌ Не удалось запустить сессию проекта <code>{v}</code>: {v2}\nЗапустить вручную:{v3}', { v: escapeHtml(dir), v2: escapeHtml(r.error), v3: manualCmd(dir, { name: sessionName(d, dir) }) }))
  d.store.setTopicStatus(chatId, threadId, 'waiting')
  await d.bot.api.closeForumTopic(chatId, threadId).catch(err => d.log(`closeForumTopic failed: ${err}`))
}

/**
 * Close idle sessions: user sessions after USER_IDLE_MIN, project sessions
 * after PROJECT_IDLE_MIN (0 = never, the default). Only the journal hears of
 * it; the next DM or topic message wakes them up by themselves with their
 * conversation (autoresume.ts). The main session is never closed.
 */
export function startIdleCloser(d: Daemon): void {
  const closing = new WeakSet<Session>()
  setInterval(() => {
    for (const s of d.activeSessions()) {
      const kind = idleKind(d, s)
      const min = kind ? idleMin(d, kind) : 0
      if (min <= 0 || s.turn || s.status !== 'idle' || closing.has(s)) continue
      if (Date.now() - s.lastActivity < min * 60_000) continue
      if (!s.tmuxPane) continue
      // Marked first: the disconnect that follows says nothing in the chat.
      markIdle(d, s, idleName(min))
      if (endSession(d, s)) {
        closing.add(s)
        d.log(`${kind} session ${s.id} (${s.engine}) idle ${min} min, suspending`)
        void suspended(d, s, idleName(min)).catch(err => d.log(`suspend notice failed: ${err}`))
      } else clearIdle(d, s.cwd)
    }
  }, 60_000).unref?.()
}

/**
 * The journal's «💤 приостановлена» only once the session is really gone (its window closed too). If it outlives
 * /exit, Ctrl-C and SIGTERM, it is a live session again (messages keep going
 * to it) and the owner hears that it could not be suspended.
 */
async function suspended(d: Daemon, s: Session, period: string): Promise<void> {
  if (await waitGone(d, s.id, endTiming.checkMs * 2 + 10_000)) {
    await closeWindow(d, s.tmuxPane)
    return logSuspended(d, s, period)
  }
  clearIdle(d, s.cwd)
  d.ending.delete(s.id)
  d.log(`session ${s.id}: could not suspend, still connected`)
  await sendNotice(d, 'sessions', () => tr('⚠️ Не смог приостановить сессию <b>{v}</b> (#{id}): она не закрылась ни по /exit, ни по Ctrl-C, ни по SIGTERM. Она по-прежнему подключена; посмотрите окно в tmux.', { v: escapeHtml(s.projectName), id: s.id }))
}

/** Create the dir (if needed), bind it to the topic, start the session, tell the user where to confirm. */
export async function startProject(d: Daemon, dir: string, where: { chatId: string; threadId?: number }, bindThread?: number): Promise<void> {
  const created = !existsSync(dir)
  mkdirSync(dir, { recursive: true })
  // Binding a topic: the group it lives in (main or extra).
  const chat = bindThread != null ? where.chatId : d.topicsChatId
  if (chat && bindThread != null) {
    const t = d.store.topic(chat, bindThread)
    d.store.upsertTopic({
      chat_id: chat, thread_id: bindThread, name: t?.name ?? basename(dir), kind: 'project', project_key: dir,
      status: 'active', created_at: t?.created_at ?? Date.now(), last_activity_at: Date.now(),
    })
  }
  if (d.sessionForProject(dir)) {
    await say(d, where.chatId, where.threadId, tr('📁 <code>{v}</code> уже открыт в сессии — пишите сюда.', { v: escapeHtml(dir) }))
    return
  }
  let win: string
  try {
    win = await d.launchSession(dir, { name: sessionName(d, dir) })
    noteLaunch(d, dir, win)
  } catch (err) {
    await say(d, where.chatId, where.threadId, tr('❌ Не удалось запустить сессию в tmux: {v}', { v: escapeHtml(String(err instanceof Error ? err.message : err)) }))
    return
  }
  await say(d, where.chatId, where.threadId, [
    tr('🚀 {v} <code>{v2}</code>, запускаю Claude в tmux: окно {v3}.', { v: created ? tr('Создал проект') : tr('Проект'), v2: escapeHtml(dir), v3: escapeHtml(attachTarget(win)) }),
    '',
    tr('Подтвердите запуск каналов в терминале:') + confirmHint(win),
    tr('После этого сессия подключится к {v}.', { v: bindThread != null ? tr('этому топику') : tr('новому топику проекта') }),
  ].join('\n'), screenKb(win))
}

/**
 * The folder of a project made from a topic or a group: named by ids, not by
 * the (changeable, possibly repeated) title — PROJECTS_DIR/<group id>-<topic
 * id>, or PROJECTS_DIR/<group id> for an ordinary group. The minus of
 * Telegram's group ids is left out: a name starting with "-" reads as a flag.
 */
export function idProjectDir(chatId: string, threadId?: number): string {
  const g = chatId.replace(/^-/, '')
  return join(settings.projectsDir, threadId != null ? `${g}-${threadId}` : g)
}

/** Owner created a topic by hand → offer/start a project for it (folder by ids). */
export async function onManualTopic(d: Daemon, chatId: string, threadId: number, name: string): Promise<void> {
  const mode = settings.topicProjects
  if (mode === 'off') return
  const dir = idProjectDir(chatId, threadId)
  const other = d.store.topicForProject(chatId, dir)
  if (other && other.thread_id !== threadId && other.status === 'active') {
    await say(d, chatId, threadId, tr('📁 Проект <code>{v}</code> уже привязан к топику «{v2}». Этот топик оставляю без проекта.', { v: escapeHtml(dir), v2: escapeHtml(other.name) }))
    return
  }
  if (mode === 'ask') {
    await d.bot.api.sendMessage(chatId, tr('Создать проект {dir} и запустить в нём сессию Claude?', { dir }), {
      message_thread_id: threadId,
      reply_markup: new InlineKeyboard([[button(tr('🚀 Создать'), `np:ok:${threadId}`, 'success'), button(tr('Не надо'), `np:no:${threadId}`)]]),
    }).catch(err => d.log(`project offer failed: ${err}`))
    return
  }
  await startProject(d, dir, { chatId, threadId }, threadId)
}

export async function handleLaunchCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const lr = /^lr:(off|on):([0-9a-f]{10})$/.exec(data)
  const m = lr ?? /^np:(ok|no):(\d+)$/.exec(data)
  if (!m) return false
  if (!ctx.from || !can(ctx.from.id, 'control')) {
    await ctx.answerCallbackQuery({ text: tr('Нет доступа.') }).catch(() => {})
    return true
  }
  if (lr) { await handleRemindCallback(d, ctx, lr); return true }
  await ctx.answerCallbackQuery().catch(() => {})
  // The offer is posted in the topic itself: its group (main or extra).
  const pressedIn = String(ctx.callbackQuery?.message?.chat.id ?? '')
  const chat = d.isTopicsChat(pressedIn) ? pressedIn : d.topicsChatId
  const thread = Number(m[2])
  if (m[1] === 'no' || !chat) {
    await ctx.editMessageText(tr('Ок, без проекта.')).catch(() => {})
    return true
  }
  const t = d.store.topic(chat, thread)
  const dir = t ? idProjectDir(chat, thread) : null
  await ctx.editMessageReplyMarkup().catch(() => {})
  if (dir) await startProject(d, dir, { chatId: chat, threadId: thread }, thread)
  return true
}

export function registerLaunchCommands(d: Daemon, bot: Bot): void {
  bot.command('new_session', async ctx => {
    if (!ctx.from || !can(ctx.from.id, 'control')) return
    const inControl = ctx.chat.type === 'private' || (String(ctx.chat.id) === d.topicsChatId && !ctx.message?.is_topic_message)
    if (!inControl) return
    const dir = projectPath(ctx.match ?? '')
    if (!dir) return void ctx.reply(tr('Формат: /new_session <имя проекта или путь>\nИмя → папка в ') + settings.projectsDir)
    await startProject(d, dir, { chatId: String(ctx.chat.id) })
  })
}
