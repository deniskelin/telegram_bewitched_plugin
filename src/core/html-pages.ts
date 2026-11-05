/** Paginate generated Telegram HTML without losing text or breaking entities,
 * graphemes or balanced formatting. Prefer whole lines whenever they fit. */
export function htmlPages(html: string, max = 3600): string[] {
  if (max < 128) throw new Error('HTML page budget must be at least 128')
  const pages: string[] = []
  let stack: { name: string; html: string }[] = [], page = '', hasText = false
  const close = (tags = stack) => [...tags].reverse().map(t => `</${t.name}>`).join('')
  const flush = () => { if (hasText) pages.push(page + close()); page = stack.map(t => t.html).join(''); hasText = false }
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const line of html.split(/(?<=\n)/)) {
    if (hasText && page.length + line.length + close().length > max) flush()
    for (const match of line.matchAll(/<\/?[a-zA-Z][^>]*>|&(?:#x[\da-fA-F]+|#\d+|[a-zA-Z]+);|[^<&]+|[<&]/g)) {
      const token = match[0]
      const atoms = token.startsWith('<') || token.startsWith('&') ? [token] : [...segmenter.segment(token)].map(s => s.segment)
      for (const atom of atoms) {
        const tag = /^<(\/?)([\w-]+)[^>]*>$/.exec(atom)
        const next = [...stack]
        if (tag && !atom.endsWith('/>')) {
          if (tag[1]) { if (next.at(-1)?.name === tag[2]!.toLowerCase()) next.pop() }
          else next.push({ name: tag[2]!.toLowerCase(), html: atom })
        }
        if (hasText && page.length + atom.length + close(next).length > max) flush()
        page += atom; stack = next
        if (!tag && atom.trim()) hasText = true
      }
    }
  }
  if (hasText) pages.push(page + close())
  return pages.length ? pages : [html]
}
