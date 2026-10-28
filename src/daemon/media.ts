/** Telegram files to the local inbox. */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { INBOX_DIR, settings } from '../config.ts'
import type { Daemon } from './daemon.ts'

/** Download a file by file_id into INBOX_DIR; returns its path. */
export async function downloadToInbox(d: Daemon, fileId: string): Promise<string> {
  const file = await d.bot.api.getFile(fileId)
  if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
  const res = await fetch(`${settings.apiRoot ?? 'https://api.telegram.org'}/file/bot${d.token}/${file.file_path}`)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}
