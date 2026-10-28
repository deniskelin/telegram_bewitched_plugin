#!/usr/bin/env bun
/**
 * bewitched — CLI for the telegram-bewitched daemon.
 *
 *   bewitched daemon start|stop|restart|status|logs|install-cron
 *   bewitched notify [--topic <name>] [--silent] <text…>
 *   bewitched status
 *   bewitched voice install [stt|tts]   # local faster-whisper / Silero in STATE_DIR/voice
 */

import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { DAEMON_LOG, PLUGIN_ROOT, httpToken, settings } from '../src/config.ts'
import { daemonPid, ensureDaemon } from '../src/spawn.ts'
import { isAlive } from '../src/proc.ts'

const [cmd, sub, ...rest] = process.argv.slice(2)

async function api(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${settings.httpPort}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${httpToken()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`)
  return json
}

async function stop(): Promise<void> {
  const pid = daemonPid()
  if (!pid) return void console.log('daemon is not running')
  process.kill(pid, 'SIGTERM')
  // Wait for the process itself, not just the pid file — it still holds the HTTP port until exit.
  for (let i = 0; i < 50 && isAlive(pid); i++) await new Promise(r => setTimeout(r, 100))
  console.log(isAlive(pid) ? `daemon ${pid} did not stop` : `stopped daemon ${pid}`)
}

function usage(): never {
  console.log(`usage:
  bewitched daemon start|stop|restart|status|logs|install-cron
  bewitched notify [--topic <name>] [--silent] <text…>
  bewitched status
  bewitched group allow-paired   # all allowlisted users may post in the topics group
  bewitched voice install [stt|tts]   # local speech recognition (faster-whisper) and voice (Silero)`)
  process.exit(1)
}

switch (cmd) {
  case 'daemon':
    switch (sub) {
      case 'start':
        console.log((await ensureDaemon()) ? `daemon running (pid ${daemonPid()})` : 'daemon failed to start — see bewitched daemon logs')
        break
      case 'stop':
        await stop()
        break
      case 'restart':
        await stop()
        console.log((await ensureDaemon()) ? `daemon running (pid ${daemonPid()})` : 'daemon failed to start')
        break
      case 'status': {
        const pid = daemonPid()
        console.log(pid ? `running, pid ${pid}` : 'not running')
        if (pid) console.log(JSON.stringify(await api('/status'), null, 2))
        break
      }
      case 'logs':
        if (existsSync(DAEMON_LOG)) console.log(readFileSync(DAEMON_LOG, 'utf8').split('\n').slice(-100).join('\n'))
        break
      case 'install-cron': {
        const line = `@reboot ${process.execPath} ${join(PLUGIN_ROOT, 'bin', 'bewitched.ts')} daemon start`
        let cur = ''
        try {
          cur = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        } catch {}
        if (cur.includes('bewitched.ts daemon start')) {
          console.log('cron entry already present')
          break
        }
        execFileSync('crontab', ['-'], { input: (cur.trimEnd() ? cur.trimEnd() + '\n' : '') + line + '\n' })
        console.log(`added: ${line}`)
        break
      }
      default:
        usage()
    }
    break
  case 'notify': {
    const args = [sub, ...rest].filter(a => a != null)
    let topic: string | undefined
    let silent = false
    const words: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--topic') topic = args[++i]
      else if (args[i] === '--silent') silent = true
      else words.push(args[i])
    }
    const text = words.join(' ') || (await Bun.stdin.text()).trim()
    if (!text) usage()
    console.log(JSON.stringify(await api('/notify', { text, topic, silent })))
    break
  }
  case 'status':
    console.log(JSON.stringify(await api('/status'), null, 2))
    break
  case 'group': {
    // Access changes are terminal-only on purpose: never downstream of a chat message.
    if (sub !== 'allow-paired') usage()
    const { loadAccess, saveAccess } = await import('../src/access.ts')
    const { Store } = await import('../src/db.ts')
    const { DB_FILE } = await import('../src/config.ts')
    const chat = new Store(DB_FILE).get('topics_chat_id')
    if (!chat) {
      console.log('no topics group connected')
      break
    }
    const a = loadAccess()
    a.groups[chat] = { ...(a.groups[chat] ?? { requireMention: false }), requireMention: false, allowFrom: [], allowPaired: true }
    saveAccess(a)
    console.log(`topics group ${chat}: all paired users (${a.allowFrom.join(', ')}) may post and control sessions`)
    break
  }
  case 'voice': {
    if (sub !== 'install') usage()
    const { installVoice } = await import('../src/voice/install.ts')
    await installVoice(rest[0] === 'stt' || rest[0] === 'tts' ? rest[0] : 'all')
    break
  }
  default:
    usage()
}
