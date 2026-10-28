#!/usr/bin/env bun
/**
 * Claude Code hook → daemon bridge. Reads the hook JSON from stdin, POSTs a
 * trimmed copy to the daemon and exits 0 no matter what: it must never block,
 * slow down or fail a Claude Code session. Prints nothing (stdout of some
 * hooks is injected into Claude's context).
 */

import { readFileSync } from 'fs'
import { HTTP_TOKEN_FILE, settings } from '../src/config.ts'
import { findClaudePid } from '../src/proc.ts'

const KEEP = ['hook_event_name', 'session_id', 'transcript_path', 'permission_mode', 'tool_name', 'tool_input', 'delta', 'final', 'last_assistant_message', 'cwd']

async function main(): Promise<void> {
  let token: string
  try {
    token = readFileSync(HTTP_TOKEN_FILE, 'utf8').trim()
  } catch {
    return // daemon never ran
  }
  const raw = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>
  const data: Record<string, unknown> = {}
  for (const k of KEEP) if (k in raw) data[k] = raw[k]
  // Tool inputs can be huge (Write content); progress only needs a summary.
  if (data.tool_input && typeof data.tool_input === 'object') {
    const ti: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(data.tool_input as Record<string, unknown>)) {
      ti[k] = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) : v
    }
    data.tool_input = ti
  }
  if (typeof data.last_assistant_message === 'string') data.last_assistant_message = data.last_assistant_message.slice(0, 2000)
  await fetch(`http://127.0.0.1:${settings.httpPort}/hook`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event: raw.hook_event_name, claudePid: findClaudePid(), data }),
    signal: AbortSignal.timeout(300),
  })
}

main().catch(() => {}).finally(() => process.exit(0))
