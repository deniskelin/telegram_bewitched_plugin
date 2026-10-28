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
