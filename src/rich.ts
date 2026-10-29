/**
 * Telegram rich messages (Bot API 10.1+), pure helpers:
 *  - screenToRich: a daemon screen in Telegram HTML ("🎛 <b>Меню</b>\n…") →
 *    rich HTML with a heading, a divider, sections and a footer;
 *  - hardBreaks: the model's Markdown, so a single newline stays a newline
 *    (rich Markdown is GFM: it would join the lines);
 *  - richToMarkdown: a received rich message (its blocks) → Markdown for the model.
 */

/** "🎛 <b>Меню</b>", "📋 <b>Сессии</b> (2)", "📊 <b>Подписка</b>: Max" — an emoji (or nothing), a bold title, a short plain tail. */
const TITLE = /^((?:[^\p{L}\p{N}\s<]\S* )?)<b>([^<\n]{1,80})<\/b>([^<\n]{0,60})$/u
const BLOCK = /<(pre|blockquote)\b[^>]*>[\s\S]*?<\/\1>/g

/** Plain lines → a paragraph; newlines become <br> (rich HTML joins them like a browser). */
function paragraph(text: string): string {
  const lines = text.split('\n').map(l => l.trimEnd())
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  if (!lines.length) return ''
  const m = TITLE.exec(lines[0])
  // A section: its title line becomes a heading.
  if (m) {
    const rest = lines.slice(1).join('<br>')
    return `<h4>${m[1]}${m[2]}${m[3]}</h4>` + (rest ? `<p>${rest}</p>` : '')
  }
  // Only italics: a note at the end, shown as the footer.
  if (lines.length === 1 && /^<i>[^]*<\/i>$/.test(lines[0]) && !lines[0].slice(3, -4).includes('<i>')) return `<footer>${lines[0].slice(3, -4)}</footer>`
  return `<p>${lines.join('<br>')}</p>`
}

/**
 * A screen to rich HTML, or null when the text is not a screen (no title line
 * and nothing after it) — notices and one-liners stay as they are.
 */
export function screenToRich(html: string): string | null {
  const nl = html.indexOf('\n')
  if (nl < 0) return null
  const m = TITLE.exec(html.slice(0, nl))
  if (!m) return null
  const out = [`<h3>${m[1]}${m[2]}${m[3]}</h3>`, '<hr/>']
  const body = html.slice(nl + 1)
  let last = 0
  const flush = (text: string) => {
    for (const p of text.split(/\n[ \t]*\n/)) {
      const r = paragraph(p)
      if (r) out.push(r)
    }
  }
  for (const b of body.matchAll(BLOCK)) {
    // A heading right before a quote ("💸 <b>Потребление</b>\n<blockquote>") stays with it.
    flush(body.slice(last, b.index))
    out.push(b[1] === 'blockquote' ? b[0].replace(/\n/g, '<br>') : b[0])
    last = b.index + b[0].length
  }
  flush(body.slice(last))
  return out.join('')
}

const FENCE = /^\s*(```|~~~)/
/** Lines that start a block of their own: no break is needed before them. */
const BLOCK_START = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||<|```|~~~|---|\*\*\*|\$\$|\[\^)/

/**
 * Two trailing spaces on every line that continues a paragraph, outside code
 * fences, tables and HTML: in rich Markdown a lone newline is a space.
 */
export function hardBreaks(md: string): string {
  const lines = md.split('\n')
  let fence = false
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]
    if (FENCE.test(line)) { fence = !fence; continue }
    if (fence) continue
    const next = lines[i + 1]
    if (!line.trim() || !next.trim()) continue
    if (/^\s*[|<]/.test(line) || /^\s*#{1,6}\s/.test(line) || /^\s*(---|\*\*\*)\s*$/.test(line)) continue
    if (BLOCK_START.test(next) && !/^\s*>/.test(next)) continue
    if (/(\s{2}|\\|<br\s*\/?>)$/.test(line)) continue
    lines[i] = line.trimEnd() + '  '
  }
  return lines.join('\n')
}

// --- received rich messages ---

type Rich = string | Rich[] | { type?: string; text?: Rich; [k: string]: unknown } | null | undefined
type Block = { type?: string; [k: string]: unknown }

/** Inline rich text → Markdown. */
export function richText(r: Rich): string {
  if (r == null) return ''
  if (typeof r === 'string') return r
  if (Array.isArray(r)) return r.map(richText).join('')
  const inner = richText(r.text)
  switch (r.type) {
    case 'bold': return `**${inner}**`
    case 'italic': return `*${inner}*`
    case 'underline': return `<u>${inner}</u>`
    case 'strikethrough': return `~~${inner}~~`
    case 'spoiler': return `||${inner}||`
    case 'marked': return `==${inner}==`
    case 'code': return `\`${inner}\``
    case 'subscript': return `<sub>${inner}</sub>`
    case 'superscript': return `<sup>${inner}</sup>`
    case 'mathematical_expression': return `$${inner}$`
    case 'url': return typeof r.url === 'string' && r.url !== inner ? `[${inner}](${r.url})` : inner
    case 'text_mention': return `${inner}`
    case 'custom_emoji': return typeof r.alternative_text === 'string' ? r.alternative_text : inner
    case 'anchor': return ''
    default: return inner
  }
}

function indent(s: string, pad: string): string {
  return s.split('\n').map((l, i) => (i === 0 ? l : pad + l)).join('\n')
}

function blocksToMd(blocks: unknown): string {
  return Array.isArray(blocks) ? blocks.map(b => blockToMd(b as Block)).filter(Boolean).join('\n\n') : ''
}

function caption(b: Block): string {
  const c = b.caption as { text?: Rich } | undefined
  return c?.text ? ` — ${richText(c.text)}` : ''
}

function blockToMd(b: Block): string {
  const text = () => richText(b.text as Rich)
  switch (b.type) {
    case 'paragraph': return text()
    case 'heading': return `${'#'.repeat(Math.min(6, Math.max(1, Number(b.size) || 2)))} ${text()}`
    case 'divider': return '---'
    case 'footer': return `<footer>${text()}</footer>`
    case 'pre': return `\`\`\`${typeof b.language === 'string' ? b.language : ''}\n${text()}\n\`\`\``
    case 'mathematical_expression': return `$$${text()}$$`
    case 'blockquote': return blocksToMd(b.blocks).split('\n').map(l => `> ${l}`.trimEnd()).join('\n') + (b.credit ? `\n> — ${richText(b.credit as Rich)}` : '')
    case 'expandable_blockquote':
    case 'pullquote': return text().split('\n').map(l => `> ${l}`).join('\n') + (b.credit ? `\n> — ${richText(b.credit as Rich)}` : '')
    case 'list': {
      const items = Array.isArray(b.items) ? (b.items as Block[]) : []
      return items.map((it, i) => {
        const mark = it.has_checkbox ? (it.is_checked ? '- [x]' : '- [ ]') : typeof it.label === 'string' && /\d/.test(it.label) ? `${i + 1}.` : '-'
        return `${mark} ${indent(blocksToMd(it.blocks), '  ')}`
      }).join('\n')
    }
    case 'details': return `<details${b.is_open ? ' open' : ''}><summary>${richText(b.summary as Rich)}</summary>\n\n${blocksToMd(b.blocks)}\n\n</details>`
    case 'table': {
      const rows = Array.isArray(b.cells) ? (b.cells as Block[][]) : []
      if (!rows.length) return ''
      const cell = (c: Block) => richText(c.text as Rich).replace(/\|/g, '\\|').replace(/\n/g, ' ')
      const line = (r: Block[]) => `| ${r.map(cell).join(' | ')} |`
      return [line(rows[0]), `|${rows[0].map(() => '---').join('|')}|`, ...rows.slice(1).map(line)].join('\n')
    }
    case 'collage':
    case 'slideshow': return blocksToMd(b.blocks) + caption(b)
    case 'photo': case 'video': case 'animation': case 'audio': case 'voice_note': case 'document':
      return `(${b.type}${caption(b)})`
    case 'map': return `(map${caption(b)})`
    case 'buttons': {
      const bs = Array.isArray(b.buttons) ? (b.buttons as { text?: Rich }[]) : []
      return bs.map(x => `[${richText(x.text)}]`).join(' ')
    }
    default: return text() || blocksToMd(b.blocks)
  }
}

/** A received rich message (Message.rich_message) as Markdown. */
export function richToMarkdown(rm: unknown): string {
  const blocks = (rm as { blocks?: unknown } | null)?.blocks
  return blocksToMd(blocks).trim()
}
