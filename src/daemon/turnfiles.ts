/**
 * FR-12: what a turn changed. During the turn the hooks give the files the
 * model edited (Edit, Write, MultiEdit, NotebookEdit) and whether it ran
 * `git commit` or `gh pr create`; HEAD is noted when the turn starts. At its
 * end «🔢 Расход хода» gets «📝 Изменено N файлов (+a −b)» (git diff --numstat
 * from that HEAD, so committed edits count too) and links to the new commit
 * and the branch's PR.
 */

import { execFile } from 'child_process'
import { relative } from 'path'
import { escapeHtml } from '../format.ts'
import { t } from '../i18n/index.ts'
import type { Session } from './daemon.ts'
import { githubBase } from '../postprocess.ts'

export type TurnChanges = { files: Set<string>; git: boolean; head: string | null }

const turns = new Map<string, TurnChanges>()

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise(res => execFile('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => res(err ? null : String(out))))
}

/** A turn began: note HEAD (best effort, in the background). */
export function turnStarted(s: Session): void {
  const tc: TurnChanges = { files: new Set(), git: false, head: null }
  turns.set(s.id, tc)
  void git(s.cwd, ['rev-parse', 'HEAD']).then(h => { tc.head = h?.trim() || null })
}

/** A tool call of the turn. */
export function noteTool(s: Session, name: string, input: Record<string, unknown> | undefined): void {
  const tc = turns.get(s.id)
  if (!tc) return
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const f = input?.file_path ?? input?.notebook_path
    if (typeof f === 'string' && f) tc.files.add(f)
  }
  if (name === 'Bash' && typeof input?.command === 'string' && /\bgit\s+commit\b|\bgh\s+pr\s+create\b/.test(input.command)) tc.git = true
}

/** The turn's changes, taken (the record is forgotten). */
export function takeTurn(s: Session): TurnChanges | null {
  const tc = turns.get(s.id) ?? null
  turns.delete(s.id)
  return tc
}

/** "+12 −3" per file from `git diff --numstat`. */
export function parseNumstat(out: string): { file: string; add: number; del: number }[] {
  return out.split('\n').flatMap(l => {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l)
    return m ? [{ file: m[3], add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]) }] : []
  })
}

/** Rich HTML for under the answer: the changed files (collapsed) and links. Null when nothing changed. */
export async function changesBlock(s: Session, tc: TurnChanges | null): Promise<string | null> {
  if (!tc || (!tc.files.size && !tc.git)) return null
  const rel = [...tc.files].map(f => relative(s.cwd, f)).filter(f => f && !f.startsWith('..'))
  const parts: string[] = []
  if (rel.length) {
    const base = tc.head ?? 'HEAD'
    const stat = parseNumstat((await git(s.cwd, ['diff', '--numstat', base, '--', ...rel])) ?? '')
    const add = stat.reduce((n, x) => n + x.add, 0)
    const del = stat.reduce((n, x) => n + x.del, 0)
    const n = stat.length || rel.length
    const head = t('📝 Изменено файлов: {n} (+{add} −{del})', { n, add, del })
    const rows = (stat.length ? stat : rel.map(file => ({ file, add: 0, del: 0 }))).slice(0, 30)
      .map(x => `<tr><td><code>${escapeHtml(x.file)}</code></td><td align="right">+${x.add} −${x.del}</td></tr>`).join('')
    parts.push(`<details><summary>${escapeHtml(head)}</summary><table bordered striped compact>${rows}</table></details>`)
  }
  if (tc.git) {
    const gh = githubBase(await git(s.cwd, ['remote', 'get-url', 'origin']))
    const now = (await git(s.cwd, ['rev-parse', 'HEAD']))?.trim()
    const links: string[] = []
    if (gh && now && now !== tc.head) links.push(`<a href="${gh}/commit/${now}">${escapeHtml(t('🔗 коммит {sha}', { sha: now.slice(0, 7) }))}</a>`)
    const pr = await new Promise<string | null>(res => execFile('gh', ['pr', 'view', '--json', 'url', '-q', '.url'], { cwd: s.cwd, timeout: 8000 }, (err, out) => res(err ? null : String(out).trim() || null)))
    if (pr && /^https:\/\/github\.com\//.test(pr)) links.push(`<a href="${escapeHtml(pr)}">${escapeHtml(t('🔗 PR'))}</a>`)
    if (links.length) parts.push(`<p>${links.join(' · ')}</p>`)
  }
  return parts.length ? parts.join('') : null
}
