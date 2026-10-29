/**
 * ffmpeg as a library: always an argument array, never a shell. Converts
 * whatever Telegram sends into 16 kHz mono WAV for speech recognition, and
 * synthesized WAV into OGG/Opus for sendVoice.
 */

import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import { settings } from '../config.ts'

function ffmpeg(args: string[], timeout = 120_000): Promise<void> {
  return new Promise((res, rej) => execFile(settings.ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout }, (err, _o, stderr) =>
    err ? rej(new Error(`ffmpeg: ${(stderr || err.message).trim().split('\n').pop()}`)) : res()))
}

/** Audio track of any voice/audio/video file → 16 kHz mono WAV (what whisper wants). */
export async function toWav16k(input: string, output: string, maxSec: number): Promise<void> {
  await ffmpeg(['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-t', String(maxSec), '-f', 'wav', output])
}

/** WAV → OGG/Opus 48 kHz mono, the format Telegram plays as a voice message; speed ≠ 1 changes the tempo, not the pitch. */
export async function toOggOpus(input: string, output: string, speed = 1): Promise<void> {
  const tempo = speed !== 1 ? ['-filter:a', `atempo=${speed}`] : []
  await ffmpeg(['-i', input, ...tempo, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', output])
}

/** Several WAVs (sentence chunks) → one WAV. */
export async function concatWav(inputs: string[], output: string): Promise<void> {
  if (inputs.length === 1) return ffmpeg(['-i', inputs[0], '-c', 'copy', output])
  const args = inputs.flatMap(i => ['-i', i])
  await ffmpeg([...args, '-filter_complex', `concat=n=${inputs.length}:v=0:a=1`, output])
}

/** Seconds of audio in a PCM WAV, from its header (no ffprobe needed). */
export function wavDuration(file: string): number {
  const b = readFileSync(file)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return 0
  let pos = 12, byteRate = 0
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4)
    const size = b.readUInt32LE(pos + 4)
    if (id === 'fmt ') byteRate = b.readUInt32LE(pos + 16)
    if (id === 'data') return byteRate ? Math.min(size, b.length - pos - 8) / byteRate : 0
    pos += 8 + size + (size % 2)
  }
  return 0
}
