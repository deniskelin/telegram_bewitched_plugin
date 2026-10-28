/** Start the daemon detached if it isn't running. Used by the MCP client and the CLI. */

import { spawn } from 'child_process'
import { existsSync, openSync, readFileSync } from 'fs'
import { join } from 'path'
import { DAEMON_LOG, LOCK_FILE, PLUGIN_ROOT, SOCK_FILE, ensureStateDir } from './config.ts'
import { cmdlineOf, isAlive } from './proc.ts'

export function daemonPid(): number | null {
  try {
    const pid = parseInt(readFileSync(LOCK_FILE, 'utf8'), 10)
    return pid > 1 && isAlive(pid) && cmdlineOf(pid).join(' ').includes('daemon/main.ts') ? pid : null
  } catch {
    return null
  }
}

export async function ensureDaemon(timeoutMs = 8000): Promise<boolean> {
  if (daemonPid() && existsSync(SOCK_FILE)) return true
  ensureStateDir()
  const out = openSync(DAEMON_LOG, 'a', 0o600)
  // detached → own process group, so it survives the Claude session that spawned it.
  const child = spawn(process.execPath, [join(PLUGIN_ROOT, 'src', 'daemon', 'main.ts')], {
    cwd: PLUGIN_ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, TMUX_PANE: '' },
  })
  child.unref()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 150))
    if (daemonPid() && existsSync(SOCK_FILE)) return true
  }
  return false
}
