/**
 * The local Python voice services (voice/stt_server.py, voice/silero_server.py)
 * run as children of the daemon: started on first use (or at start for STT),
 * health-checked, restarted if they die, stopped after idling.
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, openSync } from 'fs'
import { join } from 'path'
import { PLUGIN_ROOT, VOICE_HOME, settings } from '../config.ts'
import { t } from '../i18n/index.ts'

export class LocalService {
  private proc: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private lastUse = 0
  private idleTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    readonly name: string,
    private venv: string,
    private script: string,
    private port: () => number,
    private extraArgs: () => string[],
    private idleMin: () => number,
    private log: (m: string) => void,
  ) {}

  get python(): string {
    return join(VOICE_HOME, this.venv, 'bin', 'python')
  }

  installed(): boolean {
    return existsSync(this.python)
  }

  private async healthy(): Promise<boolean> {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port()}/health`, { signal: AbortSignal.timeout(2000) })
      return r.ok
    } catch {
      return false
    }
  }

  /** Running and answering; starts it (and waits for the model to load) if not. */
  async ensure(): Promise<void> {
    this.lastUse = Date.now()
    if (await this.healthy()) return
    this.starting ??= this.start().finally(() => { this.starting = null })
    return this.starting
  }

  private async start(): Promise<void> {
    if (!this.installed()) throw new Error(t('{name}: не установлен — bewitched voice install', { name: this.name }))
    mkdirSync(join(VOICE_HOME, 'logs'), { recursive: true })
    const out = openSync(join(VOICE_HOME, 'logs', `${this.name}.log`), 'a')
    this.proc = spawn(this.python, [join(PLUGIN_ROOT, 'voice', this.script), '--port', String(this.port()), ...this.extraArgs()], {
      stdio: ['ignore', out, out],
      env: { ...process.env, HF_HOME: join(VOICE_HOME, 'hf'), TORCH_HOME: join(VOICE_HOME, 'torch') },
    })
    this.proc.on('exit', code => {
      this.log(`${this.name} exited (${code})`)
      this.proc = null
    })
    this.log(`${this.name} starting (pid ${this.proc.pid})`)
    // The first start downloads the model: give it time.
    for (let i = 0; i < 600; i++) {
      if (await this.healthy()) {
        this.log(`${this.name} ready`)
        this.watchIdle()
        return
      }
      if (!this.proc) throw new Error(t('{name} упал при старте — см. {log}', { name: this.name, log: join(VOICE_HOME, 'logs', `${this.name}.log`) }))
      await Bun.sleep(1000)
    }
    throw new Error(t('{name} не ответил за 10 минут', { name: this.name }))
  }

  private watchIdle(): void {
    if (this.idleTimer || this.idleMin() <= 0) return
    this.idleTimer = setInterval(() => {
      if (this.proc && Date.now() - this.lastUse > this.idleMin() * 60_000) {
        this.log(`${this.name} idle ${this.idleMin()} min, stopping`)
        this.stop()
      }
    }, 60_000)
    this.idleTimer.unref?.()
  }

  stop(): void {
    this.proc?.kill('SIGTERM')
    this.proc = null
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
  }
}

/** Port of the local STT server: taken from STT_URL (first entry). */
export function sttLocalPort(): number {
  try {
    return Number(new URL(settings.sttUrls[0]).port) || 8178
  } catch {
    return 8178
  }
}

export function voiceServices(log: (m: string) => void) {
  const stt = new LocalService('stt', 'stt-venv', 'stt_server.py', sttLocalPort, () => ['--model', settings.sttLocalModel], () => 0, log)
  const silero = new LocalService('silero', 'silero-venv', 'silero_server.py', () => settings.ttsPort,
    () => ['--sample-rate', String(settings.ttsSampleRate)], () => settings.ttsIdleMin, log)
  return { stt, silero }
}
