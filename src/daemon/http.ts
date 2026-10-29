/**
 * Local HTTP endpoint on 127.0.0.1 (bearer token from STATE_DIR/http.token):
 *   POST /hook    — Claude Code hook events (progress, text, stop)
 *   POST /notify  — send to a topic from scripts/cron/CI
 *   POST /event   — an external event: posted to a project's topic and handed to its session
 *   GET  /status  — daemon state for the CLI
 */

import { prefsFor } from '../access.ts'
import { httpToken, settings } from '../config.ts'
import { fmtDuration, isOwnTool, maskSecrets, summarizeTool } from '../format.ts'
import type { Daemon, Session } from './daemon.ts'
import { handleEvent, type ExternalEvent } from './events.ts'
import { notify } from './tools.ts'
import { scheduleDashboard, sessionTarget } from './topics.ts'
import { checkContext } from './menu.ts'
import { inChat } from './lang.ts'
import { t } from '../i18n/index.ts'

const MAX_BODY = 1024 * 1024

export type HookEvent = {
  event: string
  claudePid: number | null
  data: Record<string, unknown>
}

/** Mark a turn as started on the first activity of an idle session (turns begun in the terminal). */
function touchTurn(s: Session): void {
  if (!s.turn) s.turn = { start: Date.now(), replied: false }
  if (s.status === 'idle') s.status = 'working'
  s.lastActivity = Date.now()
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
  if (typeof data.session_id === 'string') s.claude.sessionId = data.session_id
  if (typeof data.transcript_path === 'string') s.claude.transcript = data.transcript_path
  if (typeof data.permission_mode === 'string') s.claude.permissionMode = data.permission_mode
  switch (h.event) {
    case 'UserPromptSubmit':
      touchTurn(s)
      break
    case 'PreToolUse': {
      touchTurn(s)
      const name = String(data.tool_name ?? '')
      const summary = name ? summarizeTool(name, data.tool_input as Record<string, unknown>) : ''
      if (summary) s.lastTool = { text: summary, at: Date.now() }
      if (name && !isOwnTool(name)) d.streams.onTool(s, summary)
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
      if (delta) d.streams.onText(s, delta.endsWith('\n') ? delta : delta + '\n')
      break
    }
    case 'Stop':
    case 'StopFailure':
      onTurnEnd(d, s, h.event === 'StopFailure', typeof data.last_assistant_message === 'string' ? data.last_assistant_message : '')
      break
  }
  scheduleDashboard(d)
}

function onTurnEnd(d: Daemon, s: Session, failed: boolean, lastText: string): void {
  const turn = s.turn
  s.turn = null
  s.status = 'idle'
  d.streams.close(s, 'stop')
  void checkContext(d, s).catch(err => d.log(`context check failed: ${err}`))
  if (!turn || turn.replied) return
  const target = sessionTarget(d, s)
  if (!target) return
  const mode = prefsFor(target.chatId, target.threadId).notifyDone
  const took = Date.now() - turn.start
  if (mode === 'off') return
  if (mode === 'long' && took < settings.notifyLongSec * 1000 && !failed) return
  const head = failed ? t('❌ Ход завершился с ошибкой ({took})', { took: fmtDuration(took) }) : t('✅ Готово за {took}', { took: fmtDuration(took) })
  const body = maskSecrets(lastText.trim())
  const text = body ? `${head}\n\n${body.length > 300 ? body.slice(0, 299) + '…' : body}` : head
  void notify(d, s, { text }).catch(err => d.log(`done notice failed: ${err}`))
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
