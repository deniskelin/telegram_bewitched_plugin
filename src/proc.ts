/**
 * Linux /proc helpers. The MCP client and the hook script are both children
 * (via wrappers) of the same `claude` process; its PID is the key that ties a
 * hook event to the session registered by the MCP client.
 */

import { readFileSync, readlinkSync } from 'fs'
import { execFileSync } from 'child_process'
import { basename } from 'path'

function ppidOf(pid: number): number | null {
  try {
    // Field 4 of /proc/<pid>/stat; the comm field (2) may contain spaces, so
    // split after the closing paren.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(rest[1])
  } catch {
    return null
  }
}

export function cmdlineOf(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
  } catch {
    return []
  }
}

function isClaude(pid: number): boolean {
  try {
    if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'claude') return true
  } catch {}
  const argv0 = cmdlineOf(pid)[0]
  return argv0 != null && basename(argv0) === 'claude'
}

/** Nearest ancestor that is the Claude Code CLI, or null. */
export function findClaudePid(start = process.pid): number | null {
  let pid: number | null = start
  for (let i = 0; i < 16 && pid != null && pid > 1; i++) {
    if (isClaude(pid)) return pid
    pid = ppidOf(pid)
  }
  return null
}

export function cwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A session is "passive" when its MCP server runs but Claude Code didn't
 * register it as a channel: print mode, the SDK, or a launch without the
 * channel flag naming this plugin. Passive sessions never receive inbound
 * messages — this is what stops `claude -p` children from stealing them.
 */
export function isPassiveLaunch(argv: string[]): boolean {
  if (argv.includes('-p') || argv.includes('--print')) return true
  const flagIdx = argv.findIndex(a =>
    a === '--channels' || a === '--dangerously-load-development-channels'
    || a.startsWith('--channels=') || a.startsWith('--dangerously-load-development-channels='))
  if (flagIdx < 0) return true
  return !argv.slice(flagIdx).some(a => a.includes('telegram-bewitched'))
}

function envOf(pid: number): Record<string, string> {
  try {
    const out: Record<string, string> = {}
    for (const kv of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = kv.indexOf('=')
      if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1)
    }
    return out
  } catch {
    return {}
  }
}

/**
 * tmux pane the Claude process runs in. Plugin MCP servers may not inherit
 * the session's environment, so read the claude process's own environ, and
 * fall back to matching its terminal against `tmux list-panes`.
 */
export function tmuxPaneOf(pid: number | null): string | null {
  if (process.env.TMUX_PANE) return process.env.TMUX_PANE
  if (pid == null) return null
  const fromEnv = envOf(pid).TMUX_PANE
  if (fromEnv) return fromEnv
  let tty: string
  try {
    tty = readlinkSync(`/proc/${pid}/fd/0`)
  } catch {
    return null
  }
  if (!tty.startsWith('/dev/pts/')) return null
  try {
    const out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_tty}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 })
    for (const line of out.split('\n')) {
      const [id, paneTty] = line.split(' ')
      if (paneTty === tty) return id
    }
  } catch {}
  return null
}

export type GitInfo = { root: string | null; branch: string | null }

export function gitInfo(cwd: string): GitInfo {
  const run = (args: string[]) => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || null
    } catch {
      return null
    }
  }
  return { root: run(['rev-parse', '--show-toplevel']), branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) }
}
