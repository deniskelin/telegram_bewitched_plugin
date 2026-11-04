/**
 * Handing the work over when a session changes engine (Claude ⇄ Codex, the 🧠
 * switch, FR-18's fallback at the limit). Each engine keeps its own
 * conversations: without this the new engine would start blank — or from its
 * own old thread — knowing nothing of what was said. The daemon gathers, with
 * no model involved:
 *  - the turns of the outgoing conversation (what the user wrote, what was
 *    answered — the reply tool's text included) from its transcript,
 *  - the state of the work: branch, uncommitted changes, the last commits,
 * writes it to <folder>/.telegram/handoff.md and gives the new engine a short
 * first message that points to it and quotes the gist.
 */

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import type { Session } from './daemon.ts'
import { engineOf, type EngineId } from './engines.ts'
import { inboxFor } from './media.ts'
import { projectTranscriptDir } from './transcript.ts'
import { homedir } from 'os'

export type Turn = { role: 'user' | 'assistant'; who?: string; text: string; at?: string }

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex')

/** <channel …>content</channel> → the sender and the content; other text as is. */
function unwrapChannel(text: string): { who?: string; text: string } | null {
  const m = /<channel\b([^>]*)>\n?([\s\S]*?)\n?<\/channel>/.exec(text)
  if (!m) return { text }
  const attrs = m[1]
  // The resume digest and reminders are the daemon's, not the user's words.
  if (/event="(session_resume|tokens_back|handoff|handoff_summary)"/.test(attrs)) return null
  const who = /\buser="([^"]*)"/.exec(attrs)?.[1]
  return { who, text: m[2].trim() }
}

const isReply = (name: string) => /(^|__|_)reply$/.test(name)

/** Claude Code's transcript (JSONL): user messages, the model's text and its reply tool calls. */
export function claudeTurns(text: string): Turn[] {
  const out: Turn[] = []
  for (const line of text.split('\n')) {
    let o: Record<string, unknown>
    try { o = JSON.parse(line) } catch { continue }
    if (o.isSidechain) continue
    const at = typeof o.timestamp === 'string' ? o.timestamp : undefined
    const msg = o.message as { role?: string; content?: unknown } | undefined
    if (o.type === 'user' && typeof msg?.content === 'string') {
      const u = unwrapChannel(msg.content)
      if (u?.text && !msg.content.startsWith('This session is being continued')) out.push({ role: 'user', who: u.who, text: u.text, at })
      continue
    }
    if (o.type === 'attachment') {
      const a = o.attachment as { type?: string; prompt?: string }
      if (a?.type === 'queued_command' && typeof a.prompt === 'string') {
        const u = unwrapChannel(a.prompt)
        if (u?.text) out.push({ role: 'user', who: u.who, text: u.text, at })
      }
      continue
    }
    if (o.type === 'assistant' && Array.isArray(msg?.content)) {
      for (const b of msg.content as { type: string; text?: string; name?: string; input?: { text?: string } }[]) {
        if (b.type === 'text' && b.text?.trim()) out.push({ role: 'assistant', text: b.text.trim(), at })
        else if (b.type === 'tool_use' && b.name && isReply(b.name) && b.input?.text) out.push({ role: 'assistant', text: b.input.text, at })
      }
    }
  }
  return out
}

/** Codex's rollout (JSONL): user messages, reply tool calls and its own messages. */
export function codexTurns(text: string): Turn[] {
  const out: Turn[] = []
  for (const line of text.split('\n')) {
    let o: { timestamp?: string; type?: string; payload?: { type?: string; item?: Record<string, unknown> } }
    try { o = JSON.parse(line) } catch { continue }
    if (o.type !== 'event_msg' || o.payload?.type !== 'item_completed') continue
    const item = o.payload.item ?? {}
    const at = o.timestamp
    if (item.type === 'UserMessage') {
      const t = ((item.content as { text?: string }[]) ?? []).map(c => c.text ?? '').join('\n')
      const u = unwrapChannel(t)
      if (u?.text) out.push({ role: 'user', who: u.who, text: u.text, at })
    } else if (item.type === 'McpToolCall' && isReply(String(item.tool ?? ''))) {
      const t = (item.arguments as { text?: string } | undefined)?.text
      if (t) out.push({ role: 'assistant', text: t, at })
    } else if (item.type === 'AgentMessage') {
      const t = ((item.content as { text?: string }[]) ?? []).map(c => c.text ?? '').join('\n').trim()
      if (t) out.push({ role: 'assistant', text: t, at })
    }
  }
  return out
}

/** The Codex rollout of a thread: rollout-<time>-<thread id>.jsonl somewhere under sessions/. */
export function codexRollout(thread: string, home = CODEX_HOME): string | null {
  const walk = (dir: string, depth: number): string | null => {
    let names: string[]
    try { names = readdirSync(dir).sort().reverse() } catch { return null }
    for (const n of names) {
      const p = join(dir, n)
      if (depth < 3) {
        const hit = walk(p, depth + 1)
        if (hit) return hit
      } else if (n.endsWith(`${thread}.jsonl`)) return p
    }
    return null
  }
  return walk(join(home, 'sessions'), 0)
}

/** The transcript of the conversation a session runs, if it is known and readable. */
export function sessionTranscript(s: Session): string | null {
  const id = s.claude.sessionId
  if (s.engine === 'codex') return id ? codexRollout(id) : null
  if (s.claude.transcript) return s.claude.transcript
  return id ? join(projectTranscriptDir(s.cwd), `${id}.jsonl`) : null
}

export function turnsOf(engine: EngineId, path: string | null): Turn[] {
  if (!path) return []
  try {
    if (statSync(path).size > 64 * 1024 * 1024) return []
    const text = readFileSync(path, 'utf8')
    return engine === 'codex' ? codexTurns(text) : claudeTurns(text)
  } catch {
    return []
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise(res => execFile('git', args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => res(err ? '' : out.trim())))
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export type Handoff = { path: string; message: string }

/**
 * Write <folder>/.telegram/handoff.md for the session's work and return the
 * first message for the new engine. note: why the switch happened (the limit).
 */
export async function buildHandoff(s: Session, to: EngineId, note?: string, summary?: string | null): Promise<Handoff> {
  const from = engineOf(s.engine).name
  const turns = turnsOf(s.engine, sessionTranscript(s))
  const recent = turns.slice(-24)
  const firstAsk = turns.find(t => t.role === 'user')
  const lastAsk = [...turns].reverse().find(t => t.role === 'user')
  const [branch, status, diffStat, log] = await Promise.all([
    git(s.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(s.cwd, ['status', '--short']),
    git(s.cwd, ['diff', 'HEAD', '--stat']),
    git(s.cwd, ['log', '--oneline', '-8']),
  ])
  const line = (t: Turn) => `**${t.role === 'user' ? `Пользователь${t.who ? ` (${t.who})` : ''}` : from}**${t.at ? ` · ${t.at.slice(0, 16).replace('T', ' ')}` : ''}\n${clip(t.text, t.role === 'user' ? 1500 : 2500)}` // i18n-ignore: for the model
  // i18n-ignore-start: the handoff is written for the model, in the bridge's language
  const md = [
    `# Передача дел: ${from} → ${engineOf(to).name}`,
    '',
    `Папка: ${s.cwd}. Разговор ${from}: ${s.claude.sessionId ?? 'неизвестен'}. Передано ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    ...(note ? ['', `Причина: ${note}`] : []),
    ...(summary ? ['', `## Сводка от ${from} (написана им перед передачей)`, clip(summary, 6000)] : []),
    '',
    '## С чего началось',
    firstAsk ? clip(firstAsk.text, 2000) : '(транскрипт недоступен)',
    '',
    '## Последняя просьба пользователя',
    lastAsk ? clip(lastAsk.text, 2000) : '(нет)',
    '',
    `## Последние реплики (${recent.length} из ${turns.length})`,
    recent.length ? recent.map(line).join('\n\n') : '(нет)',
    '',
    '## Состояние работы',
    branch ? `Ветка: ${branch}` : 'Не git-репозиторий.',
    ...(status ? ['', 'Незакоммиченные изменения:', '```', clip(status, 4000), '```'] : branch ? ['', 'Незакоммиченных изменений нет.'] : []),
    ...(diffStat ? ['', '```', clip(diffStat, 3000), '```'] : []),
    ...(log ? ['', 'Последние коммиты:', '```', log, '```'] : []),
  ].join('\n')
  // i18n-ignore-end
  // The project's rules for agents: one engine reads CLAUDE.md, the other AGENTS.md — name what is there.
  const docs = ['CLAUDE.md', 'AGENTS.md'].filter(f => { try { return statSync(join(s.cwd, f)).isFile() } catch { return false } })
  const root = inboxFor(s.cwd).replace(/\/inbox$/, '')
  const path = join(root, 'handoff.md')
  writeFileSync(path, md + '\n')
  // i18n-ignore-start: for the model
  const message = [
    `[Передача дел: работа в этой папке шла на ${from}, теперь продолжаешь ты.${note ? ` ${note}` : ''}]`,
    `Полный контекст — ${summary ? 'сводка прежнего движка, ' : ''}последние реплики, изменения в git — в файле ${path}: прочитай его первым делом.`,
    lastAsk ? `Последняя просьба пользователя: «${clip(lastAsk.text, 600)}»` : '',
    docs.length ? `Правила проекта для агентов — в ${docs.join(' и ')}: следуй им, как прежний движок.` : '',
    'Продолжай с того места, где остановился прежний движок: не переделывай уже сделанное. Если неясно, что дальше, — коротко скажи пользователю, что принял дела, и спроси.',
  ].filter(Boolean).join('\n\n')
  // i18n-ignore-end
  return { path, message }
}

/** Where the outgoing model writes its summary for the handoff. */
export function summaryPath(s: Session): string {
  return join(inboxFor(s.cwd).replace(/\/inbox$/, ''), 'handoff-summary.md')
}

/** The request to the outgoing model. Text for the model: not translated. */
export function summaryRequest(path: string, to: EngineId): string {
  // i18n-ignore-start: for the model
  return [
    `[Передача дел: работа в этой папке сейчас перейдёт к ${engineOf(to).name}. Пользователю не отвечай.]`,
    `Запиши в файл ${path} короткую сводку для преемника (Markdown, до 60 строк):`,
    '- цель и что просил пользователь;',
    '- что уже сделано (файлы, коммиты, PR);',
    '- что осталось и следующий шаг;',
    '- принятые решения, договорённости и подводные камни.',
    'Только запиши файл — больше ничего не делай.',
  ].join('\n')
  // i18n-ignore-end
}

/**
 * FR-16: ask the outgoing session for a summary and wait for the file (and the
 * end of its turn) up to timeoutMs. Null when it did not come: the handoff is
 * then built without it, as before.
 */
export async function askSummary(s: Session, to: EngineId, deliver: (text: string) => void, alive: () => boolean, timeoutMs: number, pollMs = 1000): Promise<string | null> {
  const path = summaryPath(s)
  rmSync(path, { force: true })
  const start = Date.now()
  deliver(summaryRequest(path, to))
  let text: string | null = null
  while (Date.now() - start < timeoutMs && alive()) {
    await Bun.sleep(pollMs)
    try {
      if (statSync(path).mtimeMs >= start - 1000) text = readFileSync(path, 'utf8').trim() || null
    } catch {}
    // Written and the turn is over (or a little grace for the last write).
    if (text && (!s.turn || Date.now() - start > timeoutMs * 0.8)) break
  }
  return text
}
