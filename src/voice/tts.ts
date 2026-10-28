/**
 * Text to speech: providers behind one call, a cache, and the text clean-up
 * a voice needs (no markdown, no code, no raw links).
 *
 * - silero: the local Silero service (voice/silero_server.py, started by the
 *   daemon on demand — see voice/service.ts), OpenAI-compatible;
 * - http:   any OpenAI-compatible /v1/audio/speech (OpenAI, a self-hosted one);
 * - piper:  the piper binary with a .onnx voice.
 */

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { TTS_CACHE_DIR, settings } from '../config.ts'
import { toOggOpus, wavDuration } from './audio.ts'

export type Voice = { ogg: string; duration: number }
type Provider = 'silero' | 'piper' | 'http'

/**
 * What a voice should read: code blocks become "код в сообщении", links keep
 * their text, markdown marks and bare URLs go.
 */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (код в сообщении) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'ссылка')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[*_~|>]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function ttsEnabled(): boolean {
  return settings.ttsProvider !== 'off'
}

/** Local Silero is reached on 127.0.0.1:TTS_PORT unless TTS_URL points elsewhere. */
export function sileroUrl(): string {
  return `http://127.0.0.1:${settings.ttsPort}/v1/audio/speech`
}

async function viaHttp(url: string, key: string, text: string, voice: string, out: string): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: settings.ttsModel, input: text, voice, response_format: 'wav' }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  writeFileSync(out, Buffer.from(await res.arrayBuffer()))
}

function viaPiper(text: string, out: string): Promise<void> {
  if (!settings.piperModel) return Promise.reject(new Error('PIPER_MODEL is not set'))
  return new Promise((res, rej) => {
    const p = execFile(settings.piperBin, ['--model', settings.piperModel, '--output_file', out], { timeout: 120_000 }, err => (err ? rej(err) : res()))
    p.stdin?.end(text)
  })
}

/** Make sure the local service runs before the first request (set by the daemon). */
export let ensureSilero: () => Promise<void> = async () => {}
export function setSileroStarter(f: () => Promise<void>): void {
  ensureSilero = f
}

async function synthWav(provider: Provider, text: string, out: string): Promise<void> {
  if (provider === 'piper') return viaPiper(text, out)
  if (provider === 'silero') {
    if (!settings.ttsUrl) await ensureSilero()
    return viaHttp(settings.ttsUrl || sileroUrl(), '', text, settings.ttsVoice, out)
  }
  if (!settings.ttsUrl) throw new Error('TTS_URL is not set')
  return viaHttp(settings.ttsUrl, settings.ttsApiKey, text, settings.ttsVoice, out)
}

function cacheKey(text: string): string {
  return createHash('sha256').update(`${settings.ttsProvider}|${settings.ttsVoice}|${text}`).digest('hex').slice(0, 32)
}

/** Oldest files go first once the cache is over TTS_CACHE_MB. */
function trimCache(): void {
  const files = readdirSync(TTS_CACHE_DIR).map(f => ({ f, st: statSync(join(TTS_CACHE_DIR, f)) }))
  let total = files.reduce((n, x) => n + x.st.size, 0)
  for (const x of files.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs)) {
    if (total <= settings.ttsCacheMb * 1e6) break
    rmSync(join(TTS_CACHE_DIR, x.f), { force: true })
    total -= x.st.size
  }
}

/**
 * OGG/Opus voice for the text (already speakable), from the cache or the
 * provider, then the fallback. Throws when every provider failed.
 */
export async function synthesize(text: string): Promise<Voice> {
  mkdirSync(TTS_CACHE_DIR, { recursive: true })
  const key = cacheKey(text)
  const ogg = join(TTS_CACHE_DIR, `${key}.ogg`)
  const meta = join(TTS_CACHE_DIR, `${key}.json`)
  if (existsSync(ogg) && existsSync(meta)) return { ogg, duration: JSON.parse(readFileSync(meta, 'utf8')).duration }
  const chain = [settings.ttsProvider, settings.ttsFallback].filter((p, i, a): p is Provider => p !== 'off' && a.indexOf(p) === i)
  const errors: string[] = []
  for (const provider of chain) {
    const wav = join(TTS_CACHE_DIR, `${key}.${provider}.wav`)
    try {
      await synthWav(provider, text, wav)
      const duration = Math.max(1, Math.round(wavDuration(wav)))
      await toOggOpus(wav, ogg)
      writeFileSync(meta, JSON.stringify({ duration, provider }))
      trimCache()
      return { ogg, duration }
    } catch (err) {
      errors.push(`${provider}: ${err instanceof Error ? err.message : err}`)
    } finally {
      rmSync(wav, { force: true })
    }
  }
  throw new Error(errors.join('; ') || 'TTS is off')
}
