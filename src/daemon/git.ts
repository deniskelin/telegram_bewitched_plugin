/**
 * 🌿 Git for a session's folder in Telegram: status, the last commits, the
 * branch's pull request (via gh, if it is installed and logged in) and the
 * working-tree diff as a file.
 */

import { execFile } from 'child_process'
import { maskSecrets } from '../format.ts'

function run(cmd: string, args: string[], cwd: string, timeout = 5000): Promise<string | null> {
  return new Promise(res => execFile(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, out) => res(err ? null : String(out))))
}

export type GitInfo = { status: string; log: string; pr: { number: number; title: string; url: string; state: string } | null }

/** Null when the folder is not a git repository. */
export async function gitInfo(cwd: string): Promise<GitInfo | null> {
  const status = await run('git', ['status', '-sb'], cwd)
  if (status == null) return null
  const lines = status.trimEnd().split('\n')
  const shown = lines.length > 16 ? [...lines.slice(0, 15), `… ещё ${lines.length - 15}`] : lines
  const [log, pr] = await Promise.all([
    run('git', ['log', '-5', '--format=%h %s (%cr)'], cwd),
    run('gh', ['pr', 'view', '--json', 'number,title,url,state'], cwd, 8000),
  ])
  let parsed: GitInfo['pr'] = null
  try {
    parsed = pr ? JSON.parse(pr) : null
  } catch {}
  return { status: shown.join('\n'), log: (log ?? '').trimEnd(), pr: parsed }
}

/** `git diff HEAD` (staged and unstaged) with secrets masked; empty string when clean. */
export async function gitDiff(cwd: string): Promise<string | null> {
  const diff = await run('git', ['diff', 'HEAD'], cwd, 10_000)
  return diff == null ? null : maskSecrets(diff)
}

/** Subjects of commits made since `since` (and before `until`; all branches, no merges); null when not a repository. */
export async function commitsSince(cwd: string, since: Date, until?: Date): Promise<string[] | null> {
  const out = await run('git', ['log', '--all', '--no-merges', `--since=${since.toISOString()}`, ...(until ? [`--until=${until.toISOString()}`] : []), '--format=%s'], cwd)
  return out == null ? null : out.split('\n').filter(Boolean)
}
