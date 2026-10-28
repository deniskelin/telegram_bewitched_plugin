/**
 * Daemon ⇄ MCP client protocol: JSON objects, one per line, over the unix
 * socket STATE_DIR/daemon.sock.
 */

export type Hello = {
  t: 'hello'
  protocol: number
  claudePid: number | null
  cwd: string
  projectRoot: string
  branch: string | null
  tmuxPane: string | null
  passive: boolean
  /** Same Claude session reconnecting (daemon restart): skip the welcome card and resume summary. */
  reconnect?: boolean
}

export type ClientMsg =
  | Hello
  | { t: 'call'; id: number; name: string; args: Record<string, unknown> }
  | { t: 'perm_req'; request_id: string; tool_name: string; description: string; input_preview: string }
  | { t: 'pong' }

export type DaemonMsg =
  | { t: 'welcome'; session: string; topic: { chatId: string; threadId: number; name: string } | null }
  | { t: 'inbound'; content: string; meta: Record<string, string> }
  | { t: 'result'; id: number; ok: boolean; text: string }
  | { t: 'perm'; request_id: string; behavior: 'allow' | 'deny' }
  | { t: 'ping' }
  | { t: 'error'; message: string }

/** Accumulates socket chunks and yields complete JSON lines. */
export class LineDecoder {
  private buf = ''
  push(chunk: string): unknown[] {
    this.buf += chunk
    const out: unknown[] = []
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      try {
        out.push(JSON.parse(line))
      } catch {}
    }
    return out
  }
}

export function encode(msg: ClientMsg | DaemonMsg): string {
  return JSON.stringify(msg) + '\n'
}
