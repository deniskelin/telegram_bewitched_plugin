/**
 * Model and context size from the tail of a Claude Code transcript (JSONL):
 * the usage of the last main-thread assistant message.
 */

import { open } from 'fs/promises'

const TAIL_BYTES = 512 * 1024

export type ContextInfo = { model: string; tokens: number }

export async function contextInfo(path: string): Promise<ContextInfo | null> {
  let fh
  try {
    fh = await open(path, 'r')
    const { size } = await fh.stat()
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue
      let m: { type?: string; isSidechain?: boolean; message?: { model?: string; usage?: Record<string, number> } }
      try {
        m = JSON.parse(lines[i])
      } catch {
        continue // first line of the tail may be cut
      }
      const u = m.message?.usage
      if (m.type !== 'assistant' || m.isSidechain || !u || !m.message?.model) continue
      const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
      return { model: m.message.model, tokens }
    }
    return null
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}
