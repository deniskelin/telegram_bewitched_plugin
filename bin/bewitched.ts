#!/usr/bin/env bun
/**
 * bewitched — CLI for the telegram-bewitched daemon.
 *
 *   bewitched daemon start|stop|restart|status|logs|install-cron
 *   bewitched notify [--topic <name>] [--silent] <text…>
 *   bewitched status
 */

import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { DAEMON_LOG, PLUGIN_ROOT, httpToken, settings } from '../src/config.ts'
import { daemonPid, ensureDaemon } from '../src/spawn.ts'

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
  for (let i = 0; i < 30 && daemonPid(); i++) await new Promise(r => setTimeout(r, 100))
  console.log(daemonPid() ? `daemon ${pid} did not stop` : `stopped daemon ${pid}`)
}

function usage(): never {
  console.log(`usage:
  bewitched daemon start|stop|restart|status|logs|install-cron
  bewitched notify [--topic <name>] [--silent] <text…>
  bewitched status`)
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
  default:
    usage()
}
