/**
 * bewitched voice install: the local voice services, each in its own venv
 * under STATE_DIR/voice, models downloaded and smoke-tested, .env updated.
 *   stt — faster-whisper (large-v3-turbo by default), ~1.6 GB
 *   tts — Silero (torch CPU + the ru model), ~1–2 GB
 */

import { execFileSync, spawnSync } from 'child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { ENV_FILE, VOICE_HOME, settings } from '../config.ts'

function run(cmd: string, args: string[], env: Record<string, string> = {}): void {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } })
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`)
}

function venv(name: string): string {
  const dir = join(VOICE_HOME, name)
  if (!existsSync(join(dir, 'bin', 'python'))) run('python3', ['-m', 'venv', dir])
  run(join(dir, 'bin', 'python'), ['-m', 'pip', 'install', '-q', '--upgrade', 'pip'])
  return join(dir, 'bin', 'python')
}

/** Add KEY=value to .env unless the key is already there. */
function envDefault(key: string, value: string): void {
  const cur = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
  if (new RegExp(`^${key}=`, 'm').test(cur)) return
  appendFileSync(ENV_FILE, `${cur && !cur.endsWith('\n') ? '\n' : ''}${key}=${value}\n`)
  console.log(`.env: ${key}=${value}`)
}

export async function installVoice(what: 'stt' | 'tts' | 'all'): Promise<void> {
  try {
    execFileSync(settings.ffmpegBin, ['-version'], { stdio: 'ignore' })
  } catch {
    throw new Error('ffmpeg not found: apt-get install ffmpeg')
  }
  mkdirSync(VOICE_HOME, { recursive: true })
  const env = { HF_HOME: join(VOICE_HOME, 'hf'), TORCH_HOME: join(VOICE_HOME, 'torch') }

  if (what !== 'tts') {
    console.log('\n== STT: faster-whisper ==')
    const py = venv('stt-venv')
    run(py, ['-m', 'pip', 'install', '-q', '--default-timeout=60', 'faster-whisper'])
    // Downloads the model now rather than on the first voice message.
    run(py, ['-c', `from faster_whisper import WhisperModel; WhisperModel(${JSON.stringify(settings.sttLocalModel)}, device="cpu", compute_type="int8"); print("model ok")`], env)
    envDefault('STT_PROVIDER', 'openai-compatible')
    envDefault('STT_LOCAL', 'true')
    envDefault('STT_URL', 'http://127.0.0.1:8178/v1/audio/transcriptions')
  }

  if (what !== 'stt') {
    console.log('\n== TTS: Silero ==')
    const py = venv('silero-venv')
    run(py, ['-m', 'pip', 'install', '-q', '--default-timeout=60', 'torch', '--index-url', 'https://download.pytorch.org/whl/cpu'])
    run(py, ['-m', 'pip', 'install', '-q', '--default-timeout=60', 'numpy', 'omegaconf'])
    run(py, ['-c', 'import torch; m,_=torch.hub.load("snakers4/silero-models","silero_tts",language="ru",speaker="v4_ru",trust_repo=True); m.apply_tts(text="Проверка голоса.", speaker="xenia", sample_rate=48000); print("voice ok")'], env)
    envDefault('TTS_PROVIDER', 'silero')
    envDefault('TTS_VOICE', 'xenia')
  }
  console.log('\nГотово. Перезапустите демон: bewitched daemon restart')
}
