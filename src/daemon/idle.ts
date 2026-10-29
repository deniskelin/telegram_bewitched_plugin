/**
 * 💤 Suspending idle sessions: a session without a turn for the chosen time
 * is closed (Esc + /exit in tmux); its next message starts it again with
 * --continue. Set per kind in /menu → 💤: members' own sessions, the owner's
 * own session, project sessions — never, 12 h, a day, 3 days, a week. The
 * choice lives in the store (idle:<kind>); without one, USER_IDLE_MIN /
 * OWNER_IDLE_MIN (a week by default) / PROJECT_IDLE_MIN from .env.
 */

import { InlineKeyboard, type Context } from 'grammy'
import { can, owner } from '../access.ts'
import { k, t } from '../i18n/index.ts'
import type { Daemon, Session } from './daemon.ts'
import { show, type Screen } from './menu.ts'
import { button } from './stream.ts'

export type IdleKind = 'user' | 'owner' | 'project'
const KINDS: IdleKind[] = ['user', 'owner', 'project']

/** Minutes: never, 12 h, a day, 3 days, a week. */
const PRESETS = [0, 720, 1440, 4320, 10080] as const
const PRESET_NAME = [k('никогда'), k('12 ч'), k('сутки'), k('3 суток'), k('неделя')] as const
const KIND_NAME: Record<IdleKind, string> = { user: k('👤 Личные сессии пользователей'), owner: k('👑 Ваша личная сессия'), project: k('📂 Сессии проектов') }

function envMin(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= 0 ? v : fallback
}

/** Idle minutes before a session of this kind is suspended (0 — never). */
export function idleMin(d: Daemon, kind: IdleKind): number {
  const v = Number(d.store.get(`idle:${kind}`))
  if (d.store.get(`idle:${kind}`) != null && Number.isFinite(v)) return v
  // The owner's own session: a week unless set — it is the one they use most, but it should not hang forever.
  return kind === 'user' ? envMin('USER_IDLE_MIN', 0) : kind === 'owner' ? envMin('OWNER_IDLE_MIN', 10080) : envMin('PROJECT_IDLE_MIN', 0)
}

/** Which setting applies to a session; the main session is never suspended. */
export function idleKind(d: Daemon, s: Session): IdleKind | null {
  const role = d.roleOf(s)
  if (role === 'project') return 'project'
  if (role !== 'user') return null
  return d.userIdOf(s) === owner() ? 'owner' : 'user'
}

/** «сутки», «12 ч»… for a number of minutes; other values as hours. */
export function idleName(min: number): string {
  const i = PRESETS.indexOf(min as (typeof PRESETS)[number])
  return i >= 0 ? t(PRESET_NAME[i]) : t('{n} ч', { n: Math.round(min / 6) / 10 })
}

export function idleScreen(d: Daemon): Screen {
  const rows: ReturnType<typeof button>[][] = []
  const lines = [t('💤 <b>Приостановка сессий</b>'), t('Сессия без дела дольше выбранного закрывается; следующее сообщение запускает её снова и продолжает разговор. Главная не приостанавливается.'), '']
  for (const kind of KINDS) {
    const cur = idleMin(d, kind)
    lines.push(`${t(KIND_NAME[kind])}: <b>${idleName(cur)}</b>`)
    // One row per kind, the current choice marked like the period row in /usage.
    rows.push(PRESETS.map((m, i) => button(`${cur === m ? '• ' : ''}${t(PRESET_NAME[i])}`, `ix:${kind}:${i}`, cur === m ? 'primary' : undefined)))
  }
  lines.push('', t('<i>Строки сверху вниз: личные сессии пользователей, ваша, проекты.</i>'))
  rows.push([button(t('« Меню'), 'hub:main')])
  return { text: lines.join('\n'), kb: new InlineKeyboard(rows) }
}

/** ix:<kind>:<preset> — owner only. */
export async function handleIdleCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^ix:(user|owner|project):([0-4])$/.exec(data)
  if (!m) return false
  if (!ctx.from || !can(ctx.from.id, 'control')) {
    await ctx.answerCallbackQuery({ text: t('Нет доступа.') }).catch(() => {})
    return true
  }
  const min = PRESETS[Number(m[2])]
  d.store.set(`idle:${m[1]}`, String(min))
  await ctx.answerCallbackQuery({ text: `💤 ${t(KIND_NAME[m[1] as IdleKind])}: ${idleName(min)}` }).catch(() => {})
  await show(ctx, idleScreen(d))
  return true
}
