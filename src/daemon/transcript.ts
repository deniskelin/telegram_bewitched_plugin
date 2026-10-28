/**
 * Facts from a Claude Code transcript (JSONL), read from the end: model and
 * context size (usage of the last main-thread reply), the Remote Control
 * session (last remote_session_change) and the /rename title.
 */

import { open } from 'fs/promises'

const CHUNK = 1024 * 1024

export type TranscriptInfo = {
  model: string | null
  tokens: number | null
  /** undefined: the transcript never mentions Remote Control. */
  remoteUrl: string | null | undefined
  title: string | null
}

type Line = Record<string, unknown> & { type?: string; isSidechain?: boolean; message?: { model?: string; usage?: Record<string, number> }; attachment?: { type?: string; url?: string | null } }

/**
 * Walk the file backwards line by line until visit returns true. Transcripts
 * grow to tens of MB, and everything we need sits near the end.
 */
async function scanBackwards(path: string, visit: (line: string) => boolean): Promise<void> {
  const fh = await open(path, 'r')
  try {
    let pos = (await fh.stat()).size
    let carry = ''
    while (pos > 0) {
      const len = Math.min(CHUNK, pos)
      pos -= len
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, pos)
      const lines = (buf.toString('utf8') + carry).split('\n')
      carry = pos > 0 ? lines.shift()! : ''
      for (let i = lines.length - 1; i >= 0; i--) if (lines[i] && visit(lines[i])) return
    }
    if (carry) visit(carry)
  } finally {
    await fh.close()
  }
}

function parse(line: string): Line | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

export async function transcriptInfo(path: string): Promise<TranscriptInfo | null> {
  const info: TranscriptInfo = { model: null, tokens: null, remoteUrl: undefined, title: null }
  let usage = false
  try {
    await scanBackwards(path, line => {
      if (!usage && line.includes('"usage"')) {
        const m = parse(line)
        const u = m?.message?.usage
        if (m?.type === 'assistant' && !m.isSidechain && u && m.message?.model) {
          info.model = m.message.model
          info.tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
          usage = true
        }
      }
      if (info.remoteUrl === undefined && line.includes('"remote_session_change"')) {
        const a = parse(line)?.attachment
        if (a?.type === 'remote_session_change') info.remoteUrl = a.url ?? null
      }
      if (info.title == null && line.includes('"custom-title"')) {
        const m = parse(line)
        if (m?.type === 'custom-title' && typeof m.customTitle === 'string') info.title = m.customTitle
      }
      return usage && info.remoteUrl !== undefined && info.title != null
    })
  } catch {
    return null
  }
  return info
}
