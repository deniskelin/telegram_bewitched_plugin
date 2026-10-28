/**
 * Session cards for /sessions and /topics: type, status, id, folder, branch,
 * topic, tmux target to attach from a terminal, stop availability, timing.
 */

import { settings } from '../config.ts'
import { escapeHtml, fmtDuration } from '../format.ts'
import { topicLink } from '../tg.ts'
import { cmdlineOf } from '../proc.ts'
import type { Daemon, Session } from './daemon.ts'
import { remoteControl } from './remote.ts'
import { contextInfo } from './transcript.ts'

const ARCHIVE_PREFIX = '🗄 '
const MAX_MESSAGE = 4000

export function statusLabel(s: Session): string {
  if (s.status === 'waiting') return '🟡 ждёт разрешения'
  if (s.status === 'working') return '🔵 работает'
  return '🟢 свободна'
}

const PERMISSION_MODES: Record<string, string> = {
  default: 'обычный',
  plan: 'plan',
  acceptEdits: 'accept edits',
  auto: 'auto',
  bypassPermissions: 'bypass permissions',
  dontAsk: "don't ask",
}

/**
 * Current permission mode: the tmux status line shows it live ("auto mode on"),
 * hooks only report it on the next event.
 */
export function permissionMode(paneTail: string | null, fromHook: string | null): string | null {
  const status = paneTail?.split('\n').map(l => l.trim()).filter(Boolean).slice(-4).join(' ') ?? ''
  const m = /(auto mode|plan mode|accept edits|bypass permissions|don't ask) on/i.exec(status)
  if (m) return m[1].replace(/ mode$/i, '').toLowerCase()
  if (fromHook) return PERMISSION_MODES[fromHook] ?? fromHook
  return paneTail != null ? PERMISSION_MODES.default : null
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** tmux target as typed in a shell: quoted when it has anything but word characters. */
function shellArg(s: string): string {
  return /^[\w.:%-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** Main session first, then by project name. */
export function sortedSessions(d: Daemon): Session[] {
  const main = d.mainSession()
  return d.activeSessions().sort((a, b) => Number(b === main) - Number(a === main) || a.projectName.localeCompare(b.projectName))
}

export async function sessionCard(d: Daemon, s: Session): Promise<string> {
  const isMain = s === d.mainSession()
  const now = Date.now()
  const lines = [
    `${isMain ? '👑 <b>Главная</b>' : `📂 <b>${escapeHtml(s.projectName)}</b>`} · ${statusLabel(s)}`,
    `🆔 <code>#${s.id}</code>${s.claudePid ? ` · pid <code>${s.claudePid}</code>` : ''} · ${isMain ? 'главная' : 'проектная'}`,
    `📁 <code>${escapeHtml(s.cwd)}</code>`,
  ]
  if (s.branch) lines.push(`🌿 <code>${escapeHtml(s.branch)}</code>`)
  if (s.topic) {
    const link = topicLink(s.topic.chatId, s.topic.threadId)
    const name = escapeHtml(s.topic.name)
    lines.push(`💬 топик: ${link ? `<a href="${link}">${name}</a>` : name}`)
  } else if (isMain) lines.push('💬 личка и General')

  const loc = s.tmuxPane ? await d.tmuxLocation(s.tmuxPane) : null
  if (loc) {
    lines.push(
      `🖥 tmux: <b>${escapeHtml(loc.session)}</b> · окно ${escapeHtml(loc.window)} «${escapeHtml(loc.windowName)}» · панель ${escapeHtml(loc.pane)}`,
      `    <code>tmux attach -t ${escapeHtml(shellArg(`${loc.session}:${loc.window}`))}</code>`,
    )
  } else lines.push(s.tmuxPane ? `🖥 tmux: панель ${escapeHtml(s.tmuxPane)} не найдена` : '🖥 не в tmux')

  const rc = remoteControl(s.claudePid ? cmdlineOf(s.claudePid) : [], s.cwd, loc?.tail ?? null)
  const rcVia = { flag: 'флаг запуска', settings: 'автоподключение в настройках', pane: '/rc active в терминале' }
  lines.push(rc.on ? `📱 Remote Control: вкл (${rcVia[rc.via!]})` : `📱 Remote Control: выкл${loc ? '' : ' (без tmux видно только флаг и настройки)'}`)

  const perm = permissionMode(loc?.tail ?? null, s.claude.permissionMode)
  if (perm) lines.push(`🛡 Разрешения: ${escapeHtml(perm)}`)

  if (settings.stopMode === 'off') lines.push('⏹ Стоп: выключен (STOP_MODE=off)')
  else if (s.tmuxPane && settings.stopMode === 'interrupt') lines.push('⏹ Стоп: доступен')
  else lines.push('⏹ Стоп: только пометка для модели')

  const ctx = s.claude.transcript ? await contextInfo(s.claude.transcript) : null
  if (ctx) {
    // Over the configured window means the real one is bigger: show the size only.
    const win = settings.contextWindow
    const fill = ctx.tokens <= win ? ` из ${fmtTokens(win)} (${Math.round((ctx.tokens / win) * 100)}%)` : ''
    lines.push(`🧠 <code>${escapeHtml(ctx.model)}</code> · контекст ${fmtTokens(ctx.tokens)}${fill}`)
  }
  const tool = s.lastTool ? escapeHtml(s.lastTool.text.slice(0, 120)) : ''
  if (s.turn) lines.push(`⏳ ход идёт ${fmtDuration(now - s.turn.start)}${s.lastTool && s.lastTool.at >= s.turn.start ? ` · сейчас: ${tool}` : ''}`)
  else if (s.lastTool) lines.push(`🔧 последнее действие: ${tool}, ${fmtDuration(now - s.lastTool.at)} назад`)
  if (s.claude.sessionId) lines.push(`🧾 <code>claude --resume ${escapeHtml(s.claude.sessionId)}</code>`)
  lines.push(`⏱ запущена ${fmtDuration(now - s.connectedAt)} назад · активность ${fmtDuration(now - s.lastActivity)} назад`)
  return lines.join('\n')
}

/** Footer shared by both reports. */
function footer(d: Daemon): string {
  const passive = [...d.sessions.values()].filter(s => s.passive).length
  return [
    `👑 MAIN_DIR: <code>${escapeHtml(d.mainKey())}</code>${d.mainSession() ? '' : ' · главная не запущена'}`,
    passive ? `👻 пассивных сессий (claude -p): ${passive}` : null,
  ].filter(Boolean).join('\n')
}

export async function sessionsReport(d: Daemon): Promise<string[]> {
  const list = sortedSessions(d)
  const blocks = [`📋 <b>Сессии</b> (${list.length})`]
  for (const s of list) blocks.push(await sessionCard(d, s))
  if (!list.length) blocks.push('Нет запущенных сессий.')
  blocks.push(footer(d))
  return pack(blocks)
}

export async function topicsReport(d: Daemon, chatId: string): Promise<string[]> {
  const list = sortedSessions(d)
  const rows = d.store.topics(chatId)
  const blocks = [`📋 <b>Сессии и топики</b> · сессий ${list.length}, топиков ${rows.length}`]
  for (const s of list) blocks.push(await sessionCard(d, s))

  const served = new Set(list.map(s => s.topic && `${s.topic.chatId}:${s.topic.threadId}`).filter(Boolean))
  const idle = rows.filter(t => t.status !== 'archived' && !served.has(`${t.chat_id}:${t.thread_id}`)
    && !(t.project_key && list.some(s => s.projectKey === t.project_key)))
  if (idle.length) {
    const main = d.mainSession()
    blocks.push(`💤 <b>Без сессии</b>${main ? ' — пишет главная' : ''}\n` + idle.map(t => {
      const link = topicLink(t.chat_id, t.thread_id)
      const name = escapeHtml(t.name)
      const n = t.project_key ? d.store.pendingCount(t.project_key, settings.pendingTtlH) : 0
      return `• ${link ? `<a href="${link}">${name}</a>` : name}${n ? ` · в очереди ${n}` : ''}`
        + (t.project_key ? `\n   <code>${escapeHtml(t.project_key)}</code>` : '\n   не привязан к проекту')
    }).join('\n'))
  }
  const archived = rows.filter(t => t.status === 'archived')
  if (archived.length) blocks.push(`🗄 <b>Архив</b>: ${archived.map(t => escapeHtml(t.name.replace(ARCHIVE_PREFIX, ''))).join(', ')}`)
  blocks.push(footer(d))
  return pack(blocks)
}

/** Blocks joined by blank lines, split into messages under Telegram's limit. */
function pack(blocks: string[]): string[] {
  const out: string[] = []
  let cur = ''
  for (const b of blocks) {
    const next = cur ? `${cur}\n\n${b}` : b
    if (next.length > MAX_MESSAGE && cur) {
      out.push(cur)
      cur = b
    } else cur = next
  }
  if (cur) out.push(cur)
  return out
}
