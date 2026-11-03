/**
 * FR-13: the model's Markdown, tidied by the daemon before it goes out as a
 * rich message — no model involved, no tokens:
 *  - a code block longer than 15 lines folds into <details> «📄 lang · N строк»;
 *  - `src/x.ts:12`, commit hashes and #115 become GitHub links (when the
 *    project's remote is GitHub);
 *  - short shell commands in ```bash blocks get a «📋» copy button
 *    (copy_text, ≤ 256 characters) — rich messages cannot be copied on a phone;
 *  - a message over the rich limits is split at its ## headings instead of
 *    being cut.
 * Pure functions: the caller passes the remote and sends the parts.
 */

export type Copy = { label: string; text: string }
export type Post = { parts: string[]; copies: Copy[] }

const FOLD_LINES = 15
/** Rich message limit is 32768 characters; leave room for the footer and the turn cost. */
const PART_CHARS = 30_000
const MAX_COPIES = 4
const SHELL = /^(bash|sh|shell|console|zsh|terminal)$/i

/** https://github.com/owner/repo from a remote URL (https or ssh), or null for other hosts. */
export function githubBase(remote: string | null | undefined): string | null {
  if (!remote) return null
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return m ? `https://github.com/${m[1]}/${m[2]}` : null
}

type Segment = { code: boolean; text: string; lang?: string; body?: string }

/** Split Markdown into fenced code blocks and the text between them. */
function segments(md: string): Segment[] {
  const out: Segment[] = []
  const re = /^([ \t]*)(```|~~~)([^\n`]*)\n([\s\S]*?)\n\1\2[ \t]*$/gm
  let last = 0
  for (const m of md.matchAll(re)) {
    if (m.index! > last) out.push({ code: false, text: md.slice(last, m.index) })
    out.push({ code: true, text: m[0], lang: m[3].trim(), body: m[4] })
    last = m.index! + m[0].length
  }
  if (last < md.length) out.push({ code: false, text: md.slice(last) })
  return out
}

/** Links in plain text (not inside existing links, inline code is linked as a whole). */
export function linkify(text: string, base: string, branch?: string | null): string {
  const ref = branch && /^[\w./-]+$/.test(branch) ? branch : 'HEAD'
  const file = (path: string, line?: string) => `${base}/blob/${ref}/${path}${line ? `#L${line}` : ''}`
  // Existing links and HTML stay as they are: cut them out first.
  const keep: string[] = []
  const hold = (s: string) => `\u0000${keep.push(s) - 1}\u0000`
  let s = text.replace(/\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]+>/g, hold)
  // `src/x.ts:12` and `src/x.ts` in inline code.
  s = s.replace(/`((?:[\w.-]+\/)+[\w.-]+\.\w{1,8})(?::(\d+))?`/g, (m, p: string, l?: string) => hold(`[\`${p}${l ? `:${l}` : ''}\`](${file(p, l)})`))
  // Commit hashes in inline code.
  s = s.replace(/`([0-9a-f]{7,40})`/g, (m, h: string) => (/\d/.test(h) && /[a-f]/.test(h) ? hold(`[\`${h}\`](${base}/commit/${h})`) : m))
  // Other inline code is left alone.
  s = s.replace(/`[^`\n]+`/g, hold)
  // Bare paths with a line: src/x.ts:12.
  s = s.replace(/(^|[\s(])((?:[\w.-]+\/)+[\w.-]+\.\w{1,8}):(\d+)\b/g, (m, pre: string, p: string, l: string) => `${pre}${hold(`[${p}:${l}](${file(p, l)})`)}`)
  // #123 — an issue or PR (GitHub redirects /issues/N to the PR).
  s = s.replace(/(^|[\s(])#(\d{1,6})\b/g, (m, pre: string, n: string) => `${pre}${hold(`[#${n}](${base}/issues/${n})`)}`)
  // Restore the held pieces (nested holds unwrap in a loop).
  for (let i = 0; i < 3 && s.includes('\u0000'); i++) s = s.replace(/\u0000(\d+)\u0000/g, (m, i2: string) => keep[Number(i2)])
  return s
}

function foldCode(seg: Segment, insideDetails: boolean): string {
  const lines = (seg.body ?? '').split('\n').length
  if (lines <= FOLD_LINES || insideDetails) return seg.text
  const label = seg.lang || 'код' // i18n-ignore: the model's language (Russian answers)
  return `<details><summary>📄 ${label} · ${lines} строк</summary>\n\n${seg.text.trim()}\n\n</details>` // i18n-ignore
}

/** Split at ## headings so that each part fits PART_CHARS; a single huge section is cut at a paragraph. */
export function splitParts(md: string, max = PART_CHARS): string[] {
  if (md.length <= max) return [md]
  const sections = md.split(/\n(?=##\s)/)
  const parts: string[] = []
  let cur = ''
  for (const sec of sections) {
    if (cur && cur.length + sec.length + 1 > max) { parts.push(cur); cur = '' }
    if (sec.length > max) {
      for (const p of sec.split(/\n\n/)) {
        if (cur && cur.length + p.length + 2 > max) { parts.push(cur); cur = '' }
        cur = cur ? `${cur}\n\n${p.slice(0, max)}` : p.slice(0, max)
      }
      continue
    }
    cur = cur ? `${cur}\n${sec}` : sec
  }
  if (cur) parts.push(cur)
  return parts
}

export function postprocess(md: string, o: { github?: string | null; branch?: string | null } = {}): Post {
  const copies: Copy[] = []
  let depth = 0
  const out = segments(md).map(seg => {
    if (!seg.code) {
      depth += (seg.text.match(/<details\b/g) ?? []).length - (seg.text.match(/<\/details>/g) ?? []).length
      return o.github ? linkify(seg.text, o.github, o.branch) : seg.text
    }
    const body = (seg.body ?? '').trim()
    if (SHELL.test(seg.lang ?? '') && body && body.length <= 256 && body.split('\n').length <= 3 && copies.length < MAX_COPIES && !copies.some(c => c.text === body)) {
      const first = body.split('\n')[0].replace(/^\$\s*/, '')
      copies.push({ label: `📋 ${first.length > 28 ? first.slice(0, 27) + '…' : first}`, text: body.replace(/^\$\s*/gm, '') })
    }
    return foldCode(seg, depth > 0)
  }).join('')
  return { parts: splitParts(out), copies }
}
