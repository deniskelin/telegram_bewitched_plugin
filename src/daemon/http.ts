/**
 * Local HTTP endpoint on 127.0.0.1 (bearer token from STATE_DIR/http.token):
 *   POST /hook    — Claude Code hook events (progress, text, stop)
 *   POST /notify  — send to a topic from scripts/cron/CI
 *   POST /event   — an external event: posted to a project's topic and handed to its session
 *   GET  /status  — daemon state for the CLI
 */

import { watchApprovalSoon } from './codexapproval.ts'
import { prefsFor } from '../access.ts'
import { httpToken, settings } from '../config.ts'
import { escapeHtml, fmtDuration, isOwnTool, maskSecrets, summarizeTool } from '../format.ts'
import type { Daemon, Session } from './daemon.ts'
import { handleEvent, type ExternalEvent } from './events.ts'
import { notify } from './tools.ts'
import { scheduleDashboard, sessionTarget } from './topics.ts'
import { parsePlan } from './stream.ts'
import { changesBlock, noteTool, takeTurn, turnStarted, type TurnChanges } from './turnfiles.ts'
import { checkContext } from './menu.ts'
import { inChat } from './lang.ts'
import { classify, failureHint, onLimitFailure } from './outoftokens.ts'
import { turnCostBlock, turnCostLine } from './usage.ts'
import { editRich, sendRich } from '../tg.ts'
import { t } from '../i18n/index.ts'
import { codexFlushHeld, rememberConversation } from './engines.ts'

const MAX_BODY = 1024 * 1024

export type HookEvent = {
  event: string
  claudePid: number | null
  data: Record<string, unknown>
  /** When the hook fired (hook.ts start), ms; absent from older hook scripts. */
  at?: number
}

/** Without the fire time: a non-prompt hook this soon after Stop is taken for the ended turn's tail. */
const LATE_HOOK_MS = 3000

/** A hook of a turn that has already ended (it arrived after that turn's Stop). */
export function isLateHook(s: Pick<Session, 'turn' | 'turnEndedAt'>, h: Pick<HookEvent, 'event' | 'at'>, now = Date.now()): boolean {
  if (s.turn || s.turnEndedAt == null) return false
  if (!['PreToolUse', 'PostToolUseFailure', 'MessageDisplay'].includes(h.event)) return false
  // Claude Code shows the turn's final text after its Stop hook has fired: text alone never starts a turn
  // (a turn begins with a prompt, a delivered message or a tool call).
  if (h.event === 'MessageDisplay') return true
  return h.at != null ? h.at < s.turnEndedAt : now - s.turnEndedAt < LATE_HOOK_MS
}

/**
 * Mark a turn as started on the first activity of an idle session (turns begun in the terminal).
 * After ⏹ only a new prompt starts one: the stopped turn's late hooks (the tail of its text)
 * would mark it working, and an Escape-interrupted turn sends no Stop hook to end it.
 */
function touchTurn(s: Session, prompt = false): void {
  if (prompt) s.stoppedAt = null
  s.lastActivity = Date.now()
  if (s.stoppedAt) return
  if (!s.turn) { s.turn = { start: Date.now(), replied: false, ...(prompt ? {} : { byHook: true }) }; turnStarted(s) }
  if (s.status === 'idle') s.status = 'working'
}

export function handleHook(d: Daemon, h: HookEvent): void {
  if (h.claudePid == null) return
  const s = d.sessionByClaudePid(h.claudePid)
  if (!s || s.passive) return
  // Progress, notices and the context warning go to the session's chat: its language.
  const c = sessionTarget(d, s)
  if (c) return inChat(d, c.chatId, c.threadId, () => onHook(d, s, h))
  onHook(d, s, h)
}

function onHook(d: Daemon, s: Session, h: HookEvent): void {
  const data = h.data
  s.lastHookAt = Date.now()
  if (typeof data.session_id === 'string') {
    if (s.claude.sessionId !== data.session_id && /^[\w-]+$/.test(data.session_id)) rememberConversation(d, s, data.session_id)
    s.claude.sessionId = data.session_id
  }
  if (typeof data.transcript_path === 'string') s.claude.transcript = data.transcript_path
  if (typeof data.permission_mode === 'string') s.claude.permissionMode = data.permission_mode
  // The turn's edges in the log: when a session took a message and when it finished (tools are too many to log).
  if (isLateHook(s, h)) {
    if (h.event !== 'MessageDisplay') d.log(`hook ${h.event} of an ended turn ignored: session ${s.id}`)
    return
  }
  // A tool call of a background agent (Claude Code's own work after a turn, a subagent left running) between turns:
  // the session is not working for anyone — it opens no turn.
  if (!s.turn && typeof data.agent_id === 'string' && (h.event === 'PreToolUse' || h.event === 'PostToolUseFailure')) {
    d.log(`hook ${h.event}: session ${s.id}, ${String(data.tool_name ?? '?')} of agent ${String(data.agent_type ?? data.agent_id)} between turns, ignored`)
    return
  }
  // A turn opened without a prompt (begun in the terminal, or a daemon restart mid-turn): worth a line when the status looks wrong.
  if (!s.turn && !s.stoppedAt && (h.event === 'PreToolUse' || h.event === 'MessageDisplay')) d.log(`hook ${h.event}: session ${s.id} (${s.engine}) opens a turn${data.tool_name ? ` (${String(data.tool_name)})` : ''}`)
  if (h.event === 'SessionStart' || h.event === 'UserPromptSubmit' || h.event === 'Stop') d.log(`hook ${h.event}: session ${s.id} (${s.engine})${s.status !== 'idle' ? ` ${s.status}` : ''}`)
  switch (h.event) {
    case 'UserPromptSubmit':
      touchTurn(s, true)
      s.answer = ''
      break
    case 'PreToolUse': {
      touchTurn(s)
      const name = String(data.tool_name ?? '')
      const summary = name ? summarizeTool(name, data.tool_input as Record<string, unknown>) : ''
      if (summary) s.lastTool = { text: summary, at: Date.now() }
      // Text before a tool call was narration, not the answer.
      if (name && !isOwnTool(name)) s.answer = ''
      if (name && !isOwnTool(name)) d.streams.onTool(s, summary)
      if (name) noteTool(s, name, data.tool_input as Record<string, unknown> | undefined)
      if (name === 'TodoWrite') { s.plan = parsePlan(data.tool_input); d.streams.onPlan(s, s.plan) }
      // Codex may ask in its window before running it: the request goes to the chat as a card.
      if (name && !isOwnTool(name)) watchApprovalSoon(d, s)
      break
    }
    case 'PostToolUseFailure': {
      const name = String(data.tool_name ?? '')
      if (name && !isOwnTool(name)) d.streams.onTool(s, t('⚠️ {tool} — ошибка', { tool: summarizeTool(name, data.tool_input as Record<string, unknown>) }))
      break
    }
    case 'MessageDisplay': {
      touchTurn(s)
      const delta = typeof data.delta === 'string' ? data.delta : ''
      if (delta) s.answer = (s.answer + (delta.endsWith('\n') ? delta : delta + '\n')).slice(-20_000)
      if (delta) d.streams.onText(s, delta.endsWith('\n') ? delta : delta + '\n')
      break
    }
    case 'SessionEnd': {
      // FR-19: /exit typed in the terminal (or a logout) is a planned end — no «остановилась» for it.
      const reason = String(data.reason ?? '')
      if (reason === 'prompt_input_exit' || reason === 'logout') {
        d.ending.add(s.id)
        d.log(`session ${s.id}: ended on purpose (${reason})`)
      }
      break
    }
    case 'Stop':
    case 'StopFailure':
      s.turnEndedAt = h.at ?? Date.now()
      onTurnEnd(d, s, h.event === 'StopFailure', typeof data.last_assistant_message === 'string' ? data.last_assistant_message : '', String(data.error ?? ''))
      break
  }
  scheduleDashboard(d)
}

/**
 * A turn that ended without a Stop hook (interrupted with Esc in the window, a background tool call
 * that opened one): idle again, silently — no «готово», no cost; for Codex, what was held for it goes in now.
 */
export function endTurnQuietly(d: Daemon, s: Session): void {
  s.turn = null
  s.status = 'idle'
  s.turnEndedAt = Date.now()
  d.streams.close(s, 'stop')
  if (s.engine === 'codex') codexFlushHeld(d, s)
}

function onTurnEnd(d: Daemon, s: Session, failed: boolean, lastText: string, error = ''): void {
  if (failed && classify(error, lastText)) {
    // Out of tokens: the pause module tells the chat and holds what comes next.
    s.turn = null
    s.status = 'idle'
    d.streams.close(s, 'stop')
    void onLimitFailure(d, s, error, lastText).catch(err => d.log(`out-of-tokens failed: ${err}`))
    return
  }
  const turn = s.turn
  s.turn = null
  s.status = 'idle'
  d.streams.close(s, 'stop')
  void checkContext(d, s).catch(err => d.log(`context check failed: ${err}`))
  if (s.engine === 'codex') codexFlushHeld(d, s)
  // A session being closed on purpose (♻️, /exit, a switch): its interrupted turn is no «ошибка хода».
  if (d.ending.has(s.id)) return
  if (s.quietTurn) { s.quietTurn = false; return }
  const changes = takeTurn(s)
  if (turn) reportTurnCost(d, s, turn.start, changes)
  if (!turn || turn.replied) return
  const target = sessionTarget(d, s)
  if (!target) return
  const mode = prefsFor(target.chatId, target.threadId).notifyDone
  const took = Date.now() - turn.start
  if (mode === 'off') return
  if (mode === 'long' && took < settings.notifyLongSec * 1000 && !failed) return
  const head = failed ? t('❌ Ход завершился с ошибкой ({took})', { took: fmtDuration(took) }) : t('✅ Готово за {took}', { took: fmtDuration(took) })
  const hint = failed ? failureHint(error) : null
  const body = maskSecrets(lastText.trim())
  const text = [head, hint, body ? (body.length > 300 ? body.slice(0, 299) + '…' : body) : ''].filter(Boolean).join('\n\n')
  void notify(d, s, { text }).catch(err => d.log(`done notice failed: ${err}`))
}

/**
 * «🔢 Расход хода» (a chat setting, off by default): what the turn cost, read
 * from the transcript — the model is not asked. FR-11: appended to the turn's
 * answer itself (a grey footer and a collapsed table); when there is no such answer or the edit fails, the same block goes as a message of its own under the bot's last one. The
 * transcript lags the Stop hook a little, hence the wait.
 */
function reportTurnCost(d: Daemon, s: Session, start: number, changes: TurnChanges | null = null): void {
  const target = sessionTarget(d, s)
  if (!target || !prefsFor(target.chatId, target.threadId).turnCost) return
  const end = Date.now()
  setTimeout(() => void (async () => {
    const [cost, rich, plain] = inChat(d, target.chatId, target.threadId, () => [turnCostBlock(s, start, end), turnCostLine(s, start, end, true), turnCostLine(s, start, end)])
    if (!cost || !rich || !plain) return
    // FR-12: what the turn changed, above the cost.
    const files = await inChat(d, target.chatId, target.threadId, () => changesBlock(s, changes)).catch(() => null)
    const block = files ? `${files}${cost}` : cost
    const a = s.lastAnswer
    if (a && a.chatId === target.chatId && a.at >= start - 1000) {
      try {
        await editRich(d.bot, a.chatId, a.messageId, a.markdown != null
          ? `${a.markdown}\n\n${block}`
          : { html: `<p>${escapeHtml(a.text ?? '').replace(/\n/g, '<br>')}</p>${block}` })
        return
      } catch (err) {
        d.log(`turn cost into the answer failed, sending a line: ${err}`)
      }
    }
    const last = d.store.history(target.chatId, target.threadId ?? null, 10).filter(m => m.direction === 'out' && m.date * 1000 >= start - 1000).at(-1)
    const extra = {
      disable_notification: true,
      ...(target.threadId != null ? { message_thread_id: target.threadId } : {}),
      ...(last ? { reply_parameters: { message_id: last.message_id, allow_sending_without_reply: true } } : {}),
    }
    // The same table and footer as under an answer, as a message of its own; the one-line Markdown, then plain text, if that fails.
    try {
      await sendRich(d.bot, target.chatId, { html: block }, extra)
      return
    } catch (err) {
      d.log(`turn cost block failed, sending a line: ${err}`)
    }
    try {
      await sendRich(d.bot, target.chatId, rich, extra)
    } catch {
      await d.bot.api.sendMessage(target.chatId, plain, extra).catch(err => d.log(`turn cost failed: ${err}`))
    }
  })(), 2000).unref?.()
}

export function startHttp(d: Daemon): void {
  const token = httpToken()
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  // On restart the previous daemon may still hold the port for a moment.
  for (let attempt = 1; ; attempt++) {
    try {
      serve(d, token, json)
      return
    } catch (err) {
      if (attempt >= 30) throw err
      d.log(`http port ${settings.httpPort} busy, retrying (${attempt})`)
      Bun.sleepSync(500)
    }
  }
}

function serve(d: Daemon, token: string, json: (status: number, body: unknown) => Response): void {
  Bun.serve({
    hostname: '127.0.0.1',
    port: settings.httpPort,
    maxRequestBodySize: MAX_BODY,
    async fetch(req) {
      if (req.headers.get('authorization') !== `Bearer ${token}`) return json(401, { error: 'unauthorized' })
      const url = new URL(req.url)
      try {
        if (req.method === 'POST' && url.pathname === '/hook') {
          handleHook(d, (await req.json()) as HookEvent)
          return json(200, { ok: true })
        }
        if (req.method === 'POST' && url.pathname === '/notify') {
          const body = (await req.json()) as Record<string, unknown>
          const result = await notify(d, null, body)
          return json(200, { ok: true, result })
        }
        if (req.method === 'POST' && url.pathname === '/event') {
          const result = await handleEvent(d, (await req.json()) as ExternalEvent)
          return json(200, { ok: true, result })
        }
        if (req.method === 'GET' && url.pathname === '/status') {
          return json(200, {
            pid: process.pid,
            uptimeSec: Math.round(process.uptime()),
            polling: d.isPolling(),
            bot: d.botUsername,
            topicsChatId: d.topicsChatId,
            sessions: [...d.sessions.values()].map(s => ({
              id: s.id, project: s.projectKey, branch: s.branch, passive: s.passive, status: s.status,
              topic: s.topic, tmux: !!s.tmuxPane, connectedAt: new Date(s.connectedAt).toISOString(),
            })),
          })
        }
        return json(404, { error: 'not found' })
      } catch (err) {
        return json(400, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  })
}
