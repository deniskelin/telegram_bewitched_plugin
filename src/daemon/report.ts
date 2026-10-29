/**
 * Session cards for /sessions: type, status, id, folder, branch,
 * topic, tmux target to attach from a terminal, stop availability, timing.
 */

import { basename } from 'path'
import { owner, prefsBadge, prefsFor } from '../access.ts'
import { settings } from '../config.ts'
import { escapeHtml, fmtDuration } from '../format.ts'
import { topicLink } from '../tg.ts'
import { cmdlineOf } from '../proc.ts'
import type { Daemon, Session } from './daemon.ts'
import { remoteControl } from './remote.ts'
import { projectRules } from './permrules.ts'
import { sessionCostLine } from './usage.ts'
import { guessTranscript, transcriptInfo } from './transcript.ts'
import { k, t } from '../i18n/index.ts'


export function statusLabel(s: Session): string {
  if (s.status === 'waiting') return t('🟡 ждёт разрешения')
  if (s.status === 'working') return t('🔵 работает')
  return t('🟢 свободна')
}

const PERMISSION_MODES: Record<string, string> = {
  default: k('обычный'),
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
  if (fromHook) return PERMISSION_MODES[fromHook] ? t(PERMISSION_MODES[fromHook]) : fromHook
  return paneTail != null ? PERMISSION_MODES.default : null
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** tmux target as typed in a shell: quoted when it has anything but word characters. */
function shellArg(s: string): string {
  return /^[\w.:%@\/=+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** Main session first, then users, then projects by name. */
export function sortedSessions(d: Daemon): Session[] {
  const main = d.mainSession()
  const rank = (s: Session) => (s === main ? 0 : d.userIdOf(s) ? 1 : 2)
  return d.activeSessions().sort((a, b) => rank(a) - rank(b) || a.projectName.localeCompare(b.projectName))
}

/** 👑 Главная, 👤 <user name> or 📂 <project> — plain text. */
export function sessionLabel(d: Daemon, s: Session): string {
  const user = d.userIdOf(s)
  if (user) return `👤 ${d.userLabel(user)}`
  return s === d.mainSession() ? t('👑 Главная') : `📂 ${s.projectName}`
}

/** The chat the session answers in: its topic, its user's DMs or the owner's. Its prefs apply there. */
export function sessionChat(d: Daemon, s: Session): { chatId: string; threadId?: number } {
  if (s.group) return { chatId: s.group.chatId }
  if (s.topic) return { chatId: s.topic.chatId, threadId: s.topic.threadId }
  return { chatId: d.userIdOf(s) ?? owner() ?? '' }
}

function sessionPrefs(d: Daemon, s: Session) {
  const c = sessionChat(d, s)
  return prefsFor(c.chatId, c.threadId)
}

/**
 * The transcript: from hooks once the session did anything, before that from
 * its own --resume <id> / --continue (right after a daemon restart).
 */
function transcriptOf(s: Session, argv: string[]): string | null {
  return s.claude.transcript ?? guessTranscript(argv, s.cwd)
}

/**
 * One card per session, in three layers: a header (name, status, branch and
 * topic), the essentials in a quote (how to attach, mode/stop/RC, model and
 * context, current action) and the rest in a collapsed quote.
 */
export async function sessionCard(d: Daemon, s: Session): Promise<string> {
  const isMain = s === d.mainSession()
  const now = Date.now()
  const argv = s.argv.length ? s.argv : s.claudePid ? cmdlineOf(s.claudePid) : []
  const transcript = transcriptOf(s, argv)
  const tr = transcript ? await transcriptInfo(transcript) : null
  const loc = s.tmuxPane ? await d.tmuxLocation(s.tmuxPane) : null

  const status = s.turn ? `${statusLabel(s)} ${fmtDuration(now - s.turn.start)}` : statusLabel(s)
  const user = d.userIdOf(s)
  const label = sessionLabel(d, s)
  const icon = label.slice(0, label.indexOf(' '))
  const head = [`${icon} <b>${escapeHtml(label.slice(icon.length + 1))}</b>${tr?.title ? ` «${escapeHtml(tr.title)}»` : ''} · ${status}`]
  const where: string[] = []
  if (s.branch && !user) where.push(`🌿 ${escapeHtml(s.branch)}`)
  if (s.group) where.push(t('👥 группа «{title}»', { title: escapeHtml(s.group.title) }))
  else if (s.topic) {
    const link = topicLink(s.topic.chatId, s.topic.threadId)
    const name = escapeHtml(s.topic.name)
    where.push(`💬 ${link ? `<a href="${link}">${name}</a>` : name}`)
  } else if (user) where.push(t('💬 личка и свои сообщения в General'))
  else if (isMain) where.push(settings.userSessions ? t('💬 запасная: топики при TOPIC_NO_SESSION=main') : t('💬 личка и General'))
  if (where.length) head.push(where.join(' · '))

  const main: string[] = []
  if (loc) main.push(`🖥 <code>tmux attach -t ${escapeHtml(shellArg(`${loc.session}:${loc.window}`))}</code>`)
  else main.push(s.tmuxPane ? t('🖥 панель {v} не найдена', { v: escapeHtml(s.tmuxPane) }) : t('🖥 не в tmux'))

  const flags: string[] = []
  const perm = permissionMode(loc?.tail ?? null, s.claude.permissionMode)
  if (perm) flags.push(`🛡 ${escapeHtml(perm)}`)
  flags.push(settings.stopMode !== 'off' && s.tmuxPane && settings.stopMode === 'interrupt' ? t('⏹ стоп') : t('⏹ без стопа'))
  const rc = remoteControl(argv, s.cwd, loc?.tail ?? null, tr ? tr.remoteUrl : undefined)
  if (rc.url) flags.push(t('📱 <a href="{v}">RC вкл</a>', { v: escapeHtml(rc.url) }))
  else if (rc.on) flags.push(t('📱 RC вкл'))
  else flags.push(tr ? t('📱 RC выкл') : '📱 RC ?')
  main.push(flags.join(' · '))
  main.push(`📣 ${prefsBadge(sessionPrefs(d, s))}`)

  if (tr?.model && tr.tokens != null) {
    // Over the configured window means the real one is bigger: show the size only.
    const win = settings.contextWindow
    const fill = tr.tokens <= win ? t(' из {v} ({v2}%)', { v: fmtTokens(win), v2: Math.round((tr.tokens / win) * 100) }) : ''
    main.push(`🧠 ${escapeHtml(tr.model.replace(/^claude-/, ''))} · ${fmtTokens(tr.tokens)}${fill}`)
  }
  if (s.alwaysAllow.size) main.push(t('♾ без вопросов: {v}', { v: [...s.alwaysAllow].map(escapeHtml).join(', ') }))
  const rules = projectRules(d, s.projectKey)
  if (rules.length) main.push(t('📌 без вопросов в проекте: {v}', { v: rules.map(escapeHtml).join(', ') }))
  const cost = sessionCostLine(s)
  if (cost) main.push(cost)
  if (s.lastTool) {
    const tool = escapeHtml(s.lastTool.text.slice(0, 80))
    main.push(s.turn && s.lastTool.at >= s.turn.start ? `🔧 ${tool}` : t('🔧 {tool} · {v} назад', { tool, v: fmtDuration(now - s.lastTool.at) }))
  }

  const more = [
    `🆔 <code>#${s.id}</code>${s.claudePid ? ` · pid <code>${s.claudePid}</code>` : ''} · ${user ? t('пользователь {user}', { user }) : isMain ? t('главная') : t('проектная')}`,
    `📁 <code>${escapeHtml(s.cwd)}</code>`,
  ]
  if (loc) more.push(t('🖥 сессия {v} · окно {v2} «{v3}» · панель {v4}', { v: escapeHtml(loc.session), v2: escapeHtml(loc.window), v3: escapeHtml(loc.windowName), v4: escapeHtml(loc.pane) }))
  const sessionId = s.claude.sessionId ?? (transcript ? basename(transcript, '.jsonl') : null)
  if (sessionId) more.push(`🧾 <code>claude --resume ${escapeHtml(sessionId)}</code>`)
  more.push(t('⏱ запущена {v} назад · активность {v2} назад', { v: fmtDuration(now - s.connectedAt), v2: fmtDuration(now - s.lastActivity) }))

  return `${head.join('\n')}\n<blockquote>${main.join('\n')}</blockquote>\n<blockquote expandable>${more.join('\n')}</blockquote>`
}

/**
 * Sessions without the Telegram channel: `claude -p` runs, or a session
 * started without the channels flag — the usual reason "my session is not
 * in /sessions". For the latter, show how to restart it with the channel.
 */
export async function passiveBlock(d: Daemon): Promise<string | null> {
  const list = [...d.sessions.values()].filter(s => s.passive)
  if (!list.length) return null
  const items: string[] = []
  for (const s of list) {
    const argv = s.argv.length ? s.argv : s.claudePid ? cmdlineOf(s.claudePid) : []
    const print = argv.includes('-p') || argv.includes('--print')
    const loc = s.tmuxPane ? await d.tmuxLocation(s.tmuxPane) : null
    const lines = [`• <b>${escapeHtml(s.projectName)}</b> · <code>#${s.id}</code>${s.claudePid ? ` · pid <code>${s.claudePid}</code>` : ''} · ${print ? 'claude -p' : t('без канала')}`, `   📁 <code>${escapeHtml(s.cwd)}</code>`]
    if (loc) lines.push(`   🖥 <code>tmux attach -t ${escapeHtml(shellArg(`${loc.session}:${loc.window}`))}</code>`)
    if (!print) {
      // Same arguments (e.g. --resume <id>) plus the channel flag from CLAUDE_LAUNCH_CMD.
      const fix = [settings.launchCmd, ...argv.slice(1).map(shellArg)].join(' ')
      lines.push(t('   ⚠️ Telegram не подключён. Выйдите (/exit) и запустите:'), `   <code>${escapeHtml(fix)}</code>`)
    }
    items.push(lines.join('\n'))
  }
  return t('👻 <b>Без канала</b> ({length}) — сообщений не получают\n', { length: list.length }) + items.join('\n')
}

/** Footer of the /sessions list. */
export function footer(d: Daemon): string {
  return `👑 MAIN_DIR: <code>${escapeHtml(d.mainKey())}</code>${d.mainSession() ? '' : t(' · главная не запущена')}`
}
