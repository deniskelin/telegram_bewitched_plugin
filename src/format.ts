/** Pure text helpers: chunking, sanitizing, progress summaries. */

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

/** This plugin's own tools, as people would say it. */
const OWN_TOOLS: Record<string, string> = {
  reply: '💬 ответ в Telegram',
  ask_user: '❓ вопрос с кнопками',
  notify: '🔔 уведомление',
  react: '👍 реакция на сообщение',
  edit_message: '✏️ правка сообщения',
  download_attachment: '📎 скачивание вложения',
  get_history: '📜 чтение истории чата',
  search_messages: '🔎 поиск по сообщениям',
  get_message: '📜 чтение сообщения',
  save_memory: '🧠 сохранение памяти чата',
  read_memory: '🧠 чтение памяти чата',
  list_topics: '📋 список топиков',
  create_topic: '➕ создание топика',
  rename_topic: '✏️ переименование топика',
  archive_topic: '🗄 архивирование топика',
  delete_topic: '🗑 удаление топика',
}

/** One progress line for a tool call: "🔧 Bash: npm test". */
export function summarizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {}
  let line: string
  switch (name) {
    case 'Bash': line = `💻 ${short(i.description ?? i.command, 80)}`; break
    case 'Read': line = `📖 ${fileName(i.file_path)}`; break
    case 'Write': line = `📝 ${fileName(i.file_path)}`; break
    case 'Edit': case 'MultiEdit': line = `✏️ ${fileName(i.file_path)}`; break
    case 'Grep': line = `🔎 ${short(i.pattern, 60)}`; break
    case 'Glob': line = `🔎 ${short(i.pattern, 60)}`; break
    case 'WebSearch': line = `🌐 ${short(i.query, 70)}`; break
    case 'WebFetch': line = `🌐 ${short(i.url, 70)}`; break
    case 'Agent': case 'Task': line = `🤖 ${short(i.description, 70)}`; break
    case 'TodoWrite': line = `📋 план`; break
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name)
      const own = m && isOwnTool(name) ? OWN_TOOLS[m[2]] : undefined
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
  if (s < 60) return `${s} с`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return r ? `${m} мин ${r} с` : `${m} мин`
  return `${Math.floor(m / 60)} ч ${m % 60} мин`
}
