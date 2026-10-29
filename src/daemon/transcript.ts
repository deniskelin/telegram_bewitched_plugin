/**
 * Facts from a Claude Code transcript (JSONL), read from the end: model and
 * context size (usage of the last main-thread reply), the Remote Control
 * session (last remote_session_change) and the /rename title.
 */

import { readdirSync, statSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { CONFIG_DIR } from '../config.ts'

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

/** ~/.claude/projects/<cwd with every non-alphanumeric char as "-">. */
export function projectTranscriptDir(cwd: string, configDir = CONFIG_DIR): string {
  return join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

/**
 * Transcript of a session from its own arguments: --resume <id> names it,
 * --continue picks the newest one in the folder. Null when unknown.
 */
export function guessTranscript(argv: string[], cwd: string, configDir = CONFIG_DIR): string | null {
  const dir = projectTranscriptDir(cwd, configDir)
  const i = argv.findIndex(a => a === '--resume' || a === '-r')
  const id = i >= 0 ? argv[i + 1] : argv.find(a => a.startsWith('--resume='))?.slice('--resume='.length)
  if (id && /^[\w-]+$/.test(id)) return join(dir, `${id}.jsonl`)
  if (!argv.includes('--continue') && !argv.includes('-c')) return null
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)
    return files[0] ? join(dir, files[0]) : null
  } catch {
    return null
  }
}

export type Conversation = { id: string; path: string; mtime: number; size: number; prompt: string }

/**
 * The first thing the user said in a transcript, for a list of conversations:
 * the text of a channel message without its tag; command wrappers and the
 * session_resume digest are skipped.
 */
export async function firstPrompt(path: string): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.includes('"type":"user"')) continue
      const m = parse(line) as { type?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: unknown } } | null
      if (m?.type !== 'user' || m.isSidechain || m.isMeta) continue
      const c = m.message?.content
      let text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && typeof p === 'object' && 'text' in p ? String(p.text) : '')).join(' ') : ''
      if (/^<channel[^>]*event="session_resume"/.test(text) || /^<(command-|local-command)|^Caveat:/.test(text)) continue
      text = text.replace(/^<channel[^>]*>\s*/, '').replace(/<\/channel>\s*$/, '').replace(/\s+/g, ' ').trim()
      if (text) return text
    }
  } finally {
    await fh.close()
  }
  return ''
}

/** Conversations of a project folder, newest first. */
export async function listConversations(cwd: string, limit = 8, configDir = CONFIG_DIR): Promise<Conversation[]> {
  const dir = projectTranscriptDir(cwd, configDir)
  let files: string[]
  try {
    files = readdirSync(dir).filter(f => /^[\w-]+\.jsonl$/.test(f))
  } catch {
    return []
  }
  const all = files.map(f => ({ f, st: statSync(join(dir, f)) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, limit)
  return Promise.all(all.map(async ({ f, st }) => {
    const path = join(dir, f)
    return { id: f.slice(0, -'.jsonl'.length), path, mtime: st.mtimeMs, size: st.size, prompt: await firstPrompt(path).catch(() => '') }
  }))
}
