/**
 * Speech to text through any OpenAI-compatible /v1/audio/transcriptions
 * endpoint: a local whisper.cpp server (the default), faster-whisper,
 * OpenAI or Groq — the difference is only STT_URL and the key. Several
 * endpoints in STT_URL form the fallback chain.
 */

import { readFileSync } from 'fs'
import { basename } from 'path'
import { settings } from '../config.ts'

export type SttResult = { text: string; language?: string; duration?: number; provider: string }

export function sttEnabled(): boolean {
  return settings.sttProvider !== 'off' && settings.sttUrls.length > 0
}

async function viaEndpoint(url: string, key: string, wav: string): Promise<SttResult> {
  const form = new FormData()
  form.append('file', new Blob([readFileSync(wav)], { type: 'audio/wav' }), basename(wav))
  form.append('model', settings.sttModel)
  form.append('response_format', 'verbose_json')
  if (settings.sttLanguage) form.append('language', settings.sttLanguage)
  const res = await fetch(url, {
    method: 'POST',
    body: form,
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(Math.max(60_000, settings.sttMaxSec * 1000)),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const body = await res.json() as { text?: string; language?: string; duration?: number }
  const text = (body.text ?? '').trim()
  return { text, language: body.language, duration: body.duration, provider: new URL(url).host }
}

/** Make sure the local server runs before the first request (set by the daemon when STT_LOCAL=true). */
let ensureLocal: () => Promise<void> = async () => {}
export function setLocalSttStarter(f: () => Promise<void>): void {
  ensureLocal = f
}

/** Try each endpoint in order; the error lists every failure. */
export async function transcribe(wav: string): Promise<SttResult> {
  const keys = settings.sttKeys
  const errors: string[] = []
  for (const [i, url] of settings.sttUrls.entries()) {
    try {
      if (i === 0 && settings.sttLocal) await ensureLocal()
      return await viaEndpoint(url, keys[i] ?? keys[0] ?? '', wav)
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : err}`)
    }
  }
  throw new Error(errors.join('; '))
}
