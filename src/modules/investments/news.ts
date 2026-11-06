import { createHash } from 'crypto'
import { lookup } from 'dns/promises'
import { isIP } from 'net'
import type { Config, News } from './types.ts'
const keyword = (title: string, word: string) => {
  const text = title.toLowerCase(),
    needle = word.toLowerCase()
  let at = text.indexOf(needle)
  while (at >= 0) {
    const before = [...text.slice(0, at)].at(-1),
      after = [...text.slice(at + needle.length)][0]
    const letter = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch)
    if (!letter(before) && !letter(after)) return true
    at = text.indexOf(needle, at + 1)
  }
  return false
}
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
function publicAddress(ip: string): boolean {
  if (ip.includes(':')) return !/^(::|fc|fd|fe80|ff)/i.test(ip) && !ip.toLowerCase().startsWith('::ffff:')
  const p = ip.split('.').map(Number)
  return (
    p.length === 4 &&
    p[0] !== 0 &&
    p[0] !== 10 &&
    p[0] !== 127 &&
    p[0]! >= 224 &&
    !(p[0] === 169 && p[1] === 254) &&
    !(p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) &&
    !(p[0] === 192 && p[1] === 168) &&
    !(p[0] === 100 && p[1]! >= 64 && p[1]! <= 127)
  )
}
export async function publicUrl(raw: string): Promise<void> {
  const u = new URL(raw)
  if (u.protocol !== 'https:' || u.username || u.password) throw new Error('News source must be public HTTPS')
  const ips = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true })
  if (!ips.length || ips.some((p) => !publicAddress(p.address))) throw new Error('News source is not public')
}
export function parseFeed(xml: string, feed: Config['feeds'][number], held: Set<string>, now: number): News[] {
  const items = xml.match(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? []
  return items.slice(0, 100).flatMap((item) => {
    const value = (tag: string) =>
      decode(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(item)?.[1] ?? '')
    const title = value('title').slice(0, 300),
      raw = value('link') || /<link[^>]*href=["']([^"']+)["']/i.exec(item)?.[1] || '',
      date = value('pubDate') || value('published') || value('updated'),
      at = Date.parse(date)
    let url: string
    try {
      const u = new URL(raw, feed.url)
      if (u.protocol !== 'https:' || u.hostname !== new URL(feed.url).hostname) return []
      url = u.toString()
    } catch {
      return []
    }
    if (!title || !Number.isFinite(at) || at > now + 60_000 || at < now - 7 * 86400_000) return []
    const instruments = Object.entries(feed.keywords)
      .filter(([id, words]) => held.has(id) && words.some((w) => keyword(title, w)))
      .map(([id]) => id)
    if (!instruments.length) return []
    // A title signal is never represented as a verified financial fact.
    // i18n-ignore-start: Russian headline classification, not UI text.
    const critical =
      /(объявлен[^ ]* (?:технический )?дефолт|признан[^ ]* банкрот|приостановлен[^ ]* торг|не исполнен[^ ]* обязательств)/iu.test(
        title
      ) && !/(не объявлен|не признан|не приостановлен|опроверг|предотврат|избеж)/iu.test(title)
    // i18n-ignore-end
    const id = createHash('sha256').update(url).digest('hex').slice(0, 24)
    return [{ id, at, title, url, source: feed.name, instruments, critical }]
  })
}
export async function fetchNews(
  feed: Config['feeds'][number],
  held: Set<string>,
  now: number,
  fetcher: typeof fetch = fetch
): Promise<News[]> {
  await publicUrl(feed.url)
  const response = await fetcher(feed.url, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1_048_576)
    throw new Error('News source unavailable')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty feed')
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > 1_048_576) {
      await reader.cancel()
      throw new Error('News feed too large')
    }
    chunks.push(value)
  }
  return parseFeed(Buffer.concat(chunks).toString('utf8'), feed, held, now)
}
