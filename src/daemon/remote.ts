/**
 * Best-effort Remote Control detection from outside the Claude process.
 * The transcript records each connect/disconnect; before the first record we
 * fall back to the launch flags, the auto-connect setting and the "/rc active"
 * indicator in the tmux pane.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { CONFIG_DIR } from '../config.ts'

export type RemoteControl = { on: boolean; via: 'transcript' | 'flag' | 'settings' | 'pane' | null; url?: string }

const MANAGED_SETTINGS = '/etc/claude-code/managed-settings.json'

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** `claude --remote-control [name]`, `claude --rc`, `claude remote-control`. */
export function rcFromArgv(argv: string[]): boolean {
  return argv[1] === 'remote-control' || argv.some(a => a === '--remote-control' || a === '--rc' || a.startsWith('--remote-control='))
}

/**
 * Auto-connect for all sessions: `remoteControlAtStartup: true` in user or
 * managed settings (or ~/.claude.json, where /config writes). A `false` in the
 * project's settings turns it off for that repo; a `true` there is ignored.
 */
export function rcFromSettings(cwd: string, configDir = CONFIG_DIR): boolean {
  for (const f of [join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json')]) {
    if (readJson(f)?.remoteControlAtStartup === false) return false
  }
  const globalConfig = process.env.CLAUDE_CONFIG_DIR ? join(configDir, '.claude.json') : join(homedir(), '.claude.json')
  return [MANAGED_SETTINGS, join(configDir, 'settings.json'), globalConfig].some(f => readJson(f)?.remoteControlAtStartup === true)
}

/** The status line at the bottom of the pane shows "/rc active" while connected. */
export function rcFromPane(tail: string): boolean {
  const lines = tail.split('\n').map(l => l.trim()).filter(Boolean).slice(-4)
  return lines.some(l => /(^|\s)\/rc active\b/.test(l))
}

/**
 * transcriptUrl: the last remote_session_change in the transcript — the URL
 * while connected, null after disconnect, undefined when never recorded.
 * It is the only signal that also covers /remote-control typed mid-session.
 */
export function remoteControl(argv: string[], cwd: string, paneTail: string | null, transcriptUrl?: string | null): RemoteControl {
  if (transcriptUrl) return { on: true, via: 'transcript', url: transcriptUrl }
  if (transcriptUrl === null) return { on: false, via: null }
  if (rcFromArgv(argv)) return { on: true, via: 'flag' }
  if (rcFromSettings(cwd)) return { on: true, via: 'settings' }
  if (paneTail != null && rcFromPane(paneTail)) return { on: true, via: 'pane' }
  return { on: false, via: null }
}
