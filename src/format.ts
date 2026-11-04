/** Pure text helpers: chunking, sanitizing, progress summaries. */

import { k, t } from './i18n/index.ts'

/** Telegram caps messages at 4096 chars. Split long replies, preferring paragraph boundaries in 'newline' mode. */
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/**
 * Uploader-controlled strings land inside the <channel> tag as attribute
 * values — delimiter chars would let a sender break out of the tag or forge
 * another meta entry.
 */
export function safeMeta(s: string | undefined | null, max = 300): string | undefined {
  if (s == null) return undefined
  const clean = s.replace(/[<>\[\]\r\n;"]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return undefined
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const SECRET_PATTERNS: RegExp[] = [
  /\b\d{6,12}:AA[A-Za-z0-9_-]{30,}\b/g, // telegram bot token
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)\S+/gi,
]

export function maskSecrets(s: string): string {
  let out = s
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, prefix) => (typeof prefix === 'string' && m.startsWith(prefix) ? `${prefix}•••` : '•••'))
  }
  return out
}

function short(s: unknown, n: number): string {
  const str = typeof s === 'string' ? s : JSON.stringify(s) ?? ''
  const one = str.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

function fileName(p: unknown): string {
  return typeof p === 'string' ? p.split('/').slice(-2).join('/') : '?'
}

/**
 * A shell command without a description (Codex, or a call that skipped it),
 * told by what it does instead of its raw text: files read, a search, git,
 * tests. Only the first command of a chain counts, after a leading `cd …&&`.
 */
export function describeCommand(cmd: string): string {
  const first = cmd.replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, '').split(/\s*(?:&&|\|\||;|\|)\s*/)[0]?.trim() ?? ''
  const words = first.split(/\s+/)
  const [bin, sub] = [words[0]?.replace(/^.*\//, '') ?? '', words[1] ?? '']
  const files = () => words.slice(1).filter(w => /[\w-]\.\w+$/.test(w) && !w.startsWith('-')).map(fileName).slice(0, 2).join(', ')
  if (bin === 'git' || bin === 'gh') return `🌿 ${bin} ${/^[\w-]+$/.test(sub) ? sub : ''}`.trim()
  if (/^(grep|rg|ag|find|fd)$/.test(bin)) return t('🔎 поиск в файлах')
  if (bin === 'sed' && /-i/.test(first) || /^(python3?|perl)$/.test(bin) && /<</.test(first)) return t('✏️ правка файлов')
  if (/^(cat|head|tail|sed|less|wc|ls|tree)$/.test(bin)) return files() ? t('📖 чтение: {v}', { v: files() }) : t('📖 просмотр файлов')
  if (/\b(test|pytest|vitest|jest)\b/.test(first)) return t('🧪 тесты')
  if (/\btsc\b/.test(first)) return t('🧪 проверка типов')
  if (/^(bun|npm|pnpm|yarn|npx|bunx)$/.test(bin)) return `📦 ${bin} ${/^[\w:-]+$/.test(sub) ? sub : ''}`.trim()
  return t('💻 команда {v}', { v: short(bin, 30) })
}

/** This plugin's own tools, as people would say it. */
const OWN_TOOLS: Record<string, string> = {
  reply: k('💬 ответ в Telegram'),
  ask_user: k('❓ вопрос с кнопками'),
  notify: k('🔔 уведомление'),
  react: k('👍 реакция на сообщение'),
  edit_message: k('✏️ правка сообщения'),
  download_attachment: k('📎 скачивание вложения'),
  get_history: k('📜 чтение истории чата'),
  search_messages: k('🔎 поиск по сообщениям'),
  get_message: k('📜 чтение сообщения'),
  save_memory: k('🧠 сохранение памяти чата'),
  read_memory: k('🧠 чтение памяти чата'),
  list_topics: k('📋 список топиков'),
  create_topic: k('➕ создание топика'),
  rename_topic: k('✏️ переименование топика'),
  archive_topic: k('🗄 архивирование топика'),
  delete_topic: k('🗑 удаление топика'),
}

/** One progress line for a tool call: "🔧 Bash: npm test". */
export function summarizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {}
  let line: string
  switch (name) {
    case 'Bash': line = i.description ? `💻 ${short(i.description, 80)}` : describeCommand(String(i.command ?? '')); break
    case 'Read': line = `📖 ${fileName(i.file_path)}`; break
    case 'Write': line = `📝 ${fileName(i.file_path)}`; break
    case 'Edit': case 'MultiEdit': line = `✏️ ${fileName(i.file_path)}`; break
    case 'Grep': line = `🔎 ${short(i.pattern, 60)}`; break
    case 'Glob': line = `🔎 ${short(i.pattern, 60)}`; break
    case 'WebSearch': line = `🌐 ${short(i.query, 70)}`; break
    case 'WebFetch': line = `🌐 ${short(i.url, 70)}`; break
    case 'Agent': case 'Task': line = `🤖 ${short(i.description, 70)}`; break
    case 'TodoWrite': line = t('📋 план'); break
    case 'ToolSearch': line = `🧰 ${short(i.query, 70)}`; break
    case 'Skill': line = `📚 ${short(i.skill, 70)}`; break
    case 'NotebookEdit': line = `✏️ ${fileName(i.notebook_path)}`; break
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name)
      const own = m && isOwnTool(name) && OWN_TOOLS[m[2]] ? t(OWN_TOOLS[m[2]]) : undefined
      line = own ?? (m ? `🔌 ${m[1]}: ${m[2]}` : `🔧 ${name}`)
    }
  }
  return maskSecrets(line)
}

/** Our own channel tools shouldn't clutter the progress view. */
export function isOwnTool(name: string): boolean {
  return /^mcp__plugin_telegram-bewitched_/.test(name)
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return t('{s} с', { s })
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return r ? t('{m} мин {r} с', { m, r }) : t('{m} мин', { m })
  return t('{h} ч {m} мин', { h: Math.floor(m / 60), m: m % 60 })
}

/**
 * At most `max` characters, cut on whole code points (a cut through an emoji's
 * surrogate pair makes Telegram reject the text as invalid UTF-8), with "…".
 */
/**
 * Telegram HTML cut to max characters without breaking it (F04): at a line boundary where it can be, never
 * inside a tag, an entity or a surrogate pair; tags left open (a <pre> across lines) are closed; «…» marks the cut.
 */
export function clipHtml(html: string, max: number): string {
  if (html.length <= max) return html
  const budget = max - 80 // room for the closing tags and the mark
  const lines = html.split('\n')
  const kept: string[] = []
  let len = 0
  for (const line of lines) {
    if (len + line.length + 1 > budget) break
    kept.push(line)
    len += line.length + 1
  }
  if (!kept.length) {
    // One huge line: cut inside it, then drop a half tag or entity at the end.
    const cut = Array.from(lines[0]).slice(0, budget).join('')
    kept.push(cut.replace(/<[^>]*$/, '').replace(/&[#\w]*$/, ''))
  }
  let out = kept.join('\n')
  const open: string[] = []
  for (const m of out.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)) {
    if (m[3]) continue
    const tag = m[2].toLowerCase()
    if (!m[1]) open.push(tag)
    else { const i = open.lastIndexOf(tag); if (i >= 0) open.splice(i, 1) }
  }
  out += open.reverse().map(t => `</${t}>`).join('')
  return `${out}\n…`
}

export function clip(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length <= max ? s : chars.slice(0, max - 1).join('') + '…'
}
