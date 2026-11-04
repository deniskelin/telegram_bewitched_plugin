/**
 * 🌿 Git for a session's folder in Telegram: status, the last commits, the
 * branch's pull request (via gh, if it is installed and logged in) and the
 * working-tree diff as a file.
 */

import { execFile } from 'child_process'
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { maskSecrets } from '../format.ts'
import { t } from '../i18n/index.ts'

function run(cmd: string, args: string[], cwd: string, timeout = 5000): Promise<string | null> {
  return new Promise(res => execFile(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, out) => res(err ? null : String(out))))
}

export type GitInfo = { status: string; log: string; pr: { number: number; title: string; url: string; state: string } | null }

/** Null when the folder is not a git repository. */
export async function gitInfo(cwd: string): Promise<GitInfo | null> {
  const status = await run('git', ['status', '-sb'], cwd)
  if (status == null) return null
  const lines = status.trimEnd().split('\n')
  const shown = lines.length > 16 ? [...lines.slice(0, 15), t('… ещё {n}', { n: lines.length - 15 })] : lines
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

/** An untracked file larger than this is listed, not shown. */
const UNTRACKED_MAX = 200_000
/** At most this many untracked files are shown. */
const UNTRACKED_FILES = 50

/**
 * Everything not committed, with secrets masked; empty string when clean: `git diff HEAD` (staged and
 * unstaged) and — F07 — the untracked files git does not ignore, each as a new-file diff (binary or large
 * ones only named). A repository without commits yet: what is staged, plus the untracked files.
 */
export async function gitDiff(cwd: string): Promise<string | null> {
  const hasHead = (await run('git', ['rev-parse', '--verify', '-q', 'HEAD'], cwd)) != null
  const diff = await run('git', hasHead ? ['diff', 'HEAD'] : ['diff', '--cached'], cwd, 10_000)
  if (diff == null) return null
  const others = ((await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], cwd, 10_000)) ?? '').split('\0').filter(Boolean)
  const parts = [diff.trimEnd()]
  for (const f of others.slice(0, UNTRACKED_FILES)) parts.push(untrackedDiff(cwd, f))
  if (others.length > UNTRACKED_FILES) parts.push(`# … ${others.length - UNTRACKED_FILES} more untracked files not shown`) // i18n-ignore: diff text
  return maskSecrets(parts.filter(Boolean).join('\n') + (parts.some(Boolean) ? '\n' : ''))
}

/** A new file as a unified diff against nothing; a binary or large one by name only. */
function untrackedDiff(cwd: string, file: string): string {
  const head = `diff --git a/${file} b/${file}\nnew file mode 100644 (untracked)\n`
  let buf: Buffer
  try {
    const st = statSync(join(cwd, file))
    if (!st.isFile()) return ''
    if (st.size > UNTRACKED_MAX) return `${head}# ${st.size} bytes, not shown` // i18n-ignore: diff text
    buf = readFileSync(join(cwd, file))
  } catch { return '' }
  if (buf.includes(0)) return `${head}Binary file ${file} (untracked)` // i18n-ignore: diff text
  const lines = buf.toString('utf8').replace(/\n$/, '').split('\n')
  return `${head}--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}`
}

/** Subjects of commits made since `since` (and before `until`; all branches, no merges); null when not a repository. */
export async function commitsSince(cwd: string, since: Date, until?: Date): Promise<string[] | null> {
  const out = await run('git', ['log', '--all', '--no-merges', `--since=${since.toISOString()}`, ...(until ? [`--until=${until.toISOString()}`] : []), '--format=%s'], cwd)
  return out == null ? null : out.split('\n').filter(Boolean)
}
