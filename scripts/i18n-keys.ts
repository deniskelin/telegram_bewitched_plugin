/**
 * Translation keys used in the code: the first argument of every t('…') and
 * k('…') in src/ and server.ts. Used by the dictionary test, and by hand:
 *   bun scripts/i18n-keys.ts            — every key
 *   bun scripts/i18n-keys.ts missing en — keys the en dictionary lacks
 *   bun scripts/i18n-keys.ts raw        — Cyrillic still outside t()/tr()/k() ("i18n-ignore" skips a line
 *                                         and the next: text for the model, Russian on purpose)
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'i18n' ? [] : files(p)
    return p.endsWith('.ts') ? [p] : []
  })
}

export function sourceFiles(): string[] {
  return [...files(join(ROOT, 'src')), join(ROOT, 'server.ts')]
}

const CALL = /(?<![\w.])(?:tr|t|k|variants)\(\s*'((?:[^'\\\n]|\\.)*)'/g

function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
}

export function translationKeys(): Set<string> {
  const keys = new Set<string>()
  for (const f of sourceFiles()) for (const m of readFileSync(f, 'utf8').matchAll(CALL)) keys.add(unescape(m[1]))
  return keys
}

/** Lines with Cyrillic outside t()/k() and comments (speech normalization and date parsing are Russian on purpose). */
export function rawCyrillic(): string[] {
  const out: string[] = []
  for (const f of sourceFiles()) {
    if (/normalize\.ts$/.test(f)) continue
    const lines = readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      // Text for the model, not the interface: marked "i18n-ignore" on the line or the one above.
      if (line.includes('i18n-ignore') || lines[i - 1]?.includes('i18n-ignore')) return
      const code = line.replace(CALL, "t('')").replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/\/\*.*?\*\//g, '')
      if (/[А-Яа-яЁё]/.test(code)) out.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${line.trim().slice(0, 160)}`)
    })
  }
  return out
}

if (import.meta.main) {
  const [cmd, lang] = process.argv.slice(2)
  if (cmd === 'raw') console.log(rawCyrillic().join('\n'))
  else if (cmd === 'missing') {
    const dict = (await import(`../src/i18n/${lang}.ts`)).default as Record<string, string>
    console.log(JSON.stringify([...translationKeys()].filter(k => !(k in dict)), null, 1))
  } else console.log([...translationKeys()].join('\n'))
}
