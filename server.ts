#!/usr/bin/env bun
/**
 * telegram-bewitched — per-session MCP server (thin client).
 *
 * Claude Code spawns one of these per session. It does not talk to Telegram:
 * it registers the session with the shared daemon over a unix socket, relays
 * inbound messages as <channel> notifications and proxies tool calls. The
 * daemon (src/daemon/main.ts) is started on demand.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Socket } from 'bun'
import { PROTOCOL_VERSION, SOCK_FILE, loadEnv, migrateLegacy } from './src/config.ts'
import { LineDecoder, encode, type ClientMsg, type DaemonMsg, type Hello } from './src/ipc.ts'
import { cmdlineOf, cwdOf, findClaudePid, gitInfo, isPassiveLaunch, tmuxPaneOf } from './src/proc.ts'
import { ensureDaemon } from './src/spawn.ts'
import { TOOLS } from './src/client/tools.ts'
import { INSTRUCTIONS } from './src/client/instructions.ts'

function log(m: string): void {
  process.stderr.write(`telegram-bewitched: ${m}\n`)
}

migrateLegacy(log)
loadEnv()

const claudePid = findClaudePid()
const projectCwd = (claudePid && cwdOf(claudePid)) || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const git = gitInfo(projectCwd)
const passive = claudePid ? isPassiveLaunch(cmdlineOf(claudePid)) : true
const hello: Hello = {
  t: 'hello',
  protocol: PROTOCOL_VERSION,
  claudePid,
  cwd: projectCwd,
  projectRoot: git.root ?? projectCwd,
  branch: git.branch,
  tmuxPane: tmuxPaneOf(claudePid),
  passive,
}

process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', err => log(`uncaught exception: ${err}`))

const mcp = new Server(
  { name: 'telegram-bewitched', version: '1.5.4' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        // Permission relay: the daemon authenticates every replier against
        // access.allowFrom before a verdict is forwarded.
        'claude/channel/permission': {},
      },
    },
    instructions: INSTRUCTIONS,
  },
)

// --- daemon connection ---

let sock: Socket<undefined> | null = null
let nextCallId = 1
const pendingCalls = new Map<number, { resolve: (r: { ok: boolean; text: string }) => void; timer: ReturnType<typeof setTimeout> }>()
const decoder = new LineDecoder()
let shuttingDown = false
let connectedOnce = false

function sendToDaemon(msg: ClientMsg): boolean {
  if (!sock) return false
  sock.write(encode(msg))
  return true
}

function onDaemonMsg(msg: DaemonMsg): void {
  switch (msg.t) {
    case 'welcome':
      log(`registered as session #${msg.session}${msg.topic ? ` in topic "${msg.topic.name}"` : ''}${passive ? ' (passive)' : ''}`)
      return
    case 'inbound':
      if (passive) return
      void mcp.notification({ method: 'notifications/claude/channel', params: { content: msg.content, meta: msg.meta } })
        .catch(err => log(`failed to deliver inbound to Claude: ${err}`))
      return
    case 'result': {
      const p = pendingCalls.get(msg.id)
      if (!p) return
      pendingCalls.delete(msg.id)
      clearTimeout(p.timer)
      p.resolve({ ok: msg.ok, text: msg.text })
      return
    }
    case 'perm':
      void mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id: msg.request_id, behavior: msg.behavior } })
      return
    case 'ping':
      sendToDaemon({ t: 'pong' })
      return
    case 'error':
      log(`daemon: ${msg.message}`)
      return
  }
}

async function connect(): Promise<void> {
  for (let attempt = 1; !shuttingDown; attempt++) {
    try {
      if (!(await ensureDaemon())) throw new Error('daemon did not start — see logs/daemon.log')
      sock = await Bun.connect({
        unix: SOCK_FILE,
        socket: {
          data(_s, chunk) {
            for (const m of decoder.push(chunk.toString())) onDaemonMsg(m as DaemonMsg)
          },
          close() {
            sock = null
            for (const [id, p] of pendingCalls) {
              clearTimeout(p.timer)
              p.resolve({ ok: false, text: 'daemon connection lost' })
              pendingCalls.delete(id)
            }
            if (!shuttingDown) setTimeout(() => void connect(), 1000)
          },
          error(_s, err) {
            log(`socket error: ${err}`)
          },
        },
      })
      sendToDaemon({ ...hello, reconnect: connectedOnce })
      connectedOnce = true
      return
    } catch (err) {
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 4), 15_000)
      log(`cannot reach daemon (${err}); retry in ${delay / 1000}s`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

function call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  return new Promise(resolve => {
    const id = nextCallId++
    const timer = setTimeout(() => {
      pendingCalls.delete(id)
      resolve({ ok: false, text: 'daemon did not answer in 120 s' })
    }, 120_000)
    pendingCalls.set(id, { resolve, timer })
    if (!sendToDaemon({ t: 'call', id, name, args })) {
      clearTimeout(timer)
      pendingCalls.delete(id)
      resolve({ ok: false, text: 'not connected to the telegram-bewitched daemon (it is restarting); retry in a few seconds' })
    }
  })
}

// --- MCP ---

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
  }),
  async ({ params }) => {
    if (!sendToDaemon({ t: 'perm_req', ...params })) log('permission request dropped: daemon not connected')
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const r = await call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
  return r.ok
    ? { content: [{ type: 'text', text: r.text }] }
    : { content: [{ type: 'text', text: `${req.params.name} failed: ${r.text}` }], isError: true }
})

await mcp.connect(new StdioServerTransport())
void connect()

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  try {
    sock?.end()
  } catch {}
  setTimeout(() => process.exit(0), 300)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)
setInterval(() => {
  if (process.stdin.destroyed || process.stdin.readableEnded) shutdown()
}, 5000).unref()
