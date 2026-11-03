/**
 * Telegram files to disk. A file sent to a session lands in that session's
 * own folder — `<folder>/.telegram/inbox/` — so the session reads it without
 * asking: Claude Code asks before every read outside its working folder, and
 * a sender whose photo the bot "cannot open" has no way to answer that prompt.
 * Without a known folder (a download for no session) the daemon's INBOX_DIR.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { INBOX_DIR, settings } from '../config.ts'
import type { Daemon } from './daemon.ts'

/** The inbox for files meant for the session in `dir`; created on demand, kept out of git. */
export function inboxFor(dir?: string | null): string {
  if (!dir) return INBOX_DIR
  try {
    if (!statSync(dir).isDirectory()) return INBOX_DIR
  } catch {
    return INBOX_DIR
  }
  const root = join(dir, '.telegram')
  const inbox = join(root, 'inbox')
  mkdirSync(inbox, { recursive: true, mode: 0o700 })
  // A project folder is often a git repo: the sent files never end up in a commit.
  const ignore = join(root, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  return inbox
}

/** Download a file by file_id into the inbox of `dir` (INBOX_DIR without one); returns its path. */
export async function downloadToInbox(d: Daemon, fileId: string, dir?: string | null): Promise<string> {
  const file = await d.bot.api.getFile(fileId)
  if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
  const res = await fetch(`${settings.apiRoot ?? 'https://api.telegram.org'}/file/bot${d.token}/${file.file_path}`)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  const inbox = inboxFor(dir)
  mkdirSync(inbox, { recursive: true })
  const path = join(inbox, `${Date.now()}-${uniqueId}.${ext}`)
  writeFileSync(path, buf)
  d.log(`file ${uniqueId} (${buf.length} B) saved to ${path}`)
  return path
}
