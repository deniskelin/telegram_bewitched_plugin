/**
 * /menu: one message that leads everywhere — sessions, topics, statistics,
 * people, reminders, this chat's settings and help — so the command list in
 * Telegram stays short. Sections reuse the screens of /sessions, /topics,
 * /usage, /server, /users, /reports; each has a way back here.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { isOwner, loadAccess, NOTIFY_DONE_INFO, owner, prefsFor, setPref, verboseBadge, VERBOSE_INFO } from '../access.ts'
import { sttEnabled } from '../voice/stt.ts'
import { ttsEnabled } from '../voice/tts.ts'
import type { Daemon } from './daemon.ts'
import { show, type Btn, type Screen } from './menu.ts'
import { remindersScreen } from './reminders.ts'
import { reportsScreen } from './reports.ts'
import { serverReport } from './server.ts'
import { button } from './stream.ts'
import { digestReport, limitsLine, usageKeyboard, usageReport } from './usage.ts'

const BACK = () => button('« Меню', 'hub:main')
const VOICE_INFO = { off: 'текстом', mirror: 'голосом на голосовое', always: 'всегда голосом' } as const

/** Where the menu message lives: its chat and topic — the settings section is about it. */
function place(ctx: Context): { chatId: string; threadId?: number } {
  const m = ctx.callbackQuery?.message ?? ctx.message
  const threadId = m && 'is_topic_message' in m && m.is_topic_message ? m.message_thread_id : undefined
  return { chatId: String(ctx.chat!.id), threadId }
}

export function mainScreen(d: Daemon): Screen {
  const sessions = d.activeSessions()
  const lines = ['🎛 <b>Меню</b>', `Сессий: ${sessions.length}${d.permissions.size ? ` · 🔐 ждут разрешения: ${d.permissions.size}` : ''}`]
  const limits = limitsLine()
  if (limits) lines.push(limits)
  const kb: Btn[][] = [
    [button('📋 Сессии', 'sm:list'), button('📂 Топики', 'tm:list')],
    [button('📊 Статистика', 'hub:stats'), button('👥 Люди', 'hub:people')],
    [button('⏰ Напоминания', 'hub:rem'), button('⚙️ Настройки чата', 'hub:set')],
    [button('❓ Помощь', 'hub:help')],
  ]
  return { text: lines.join('\n'), kb: new InlineKeyboard(kb as never) }
}

function statsScreen(): Screen {
  return {
    text: '📊 <b>Статистика</b>\nЛимиты подписки и расход, итоги дня, отчёты за период с графиком, нагрузка сервера.',
    kb: new InlineKeyboard([
      [button('📊 Лимиты и расход', 'hub:usage'), button('🌙 Итоги дня', 'hub:digest')],
      [button('📈 Отчёты', 'hub:reports'), button('🖥 Сервер', 'srv:refresh')],
      [BACK()],
    ]),
  }
}

function peopleScreen(d: Daemon): Screen {
  return {
    text: `👥 <b>Люди</b>\nВ доступе: ${loadAccess().allowFrom.length} · ждут разрешения: ${d.permissions.size}`,
    kb: new InlineKeyboard([
      [button('👥 Пользователи', 'ur:list'), button('➕ Пригласить', 'inv:start')],
      [button(`🔐 Разрешения (${d.permissions.size})`, 'sm:perms')],
      [BACK()],
    ]),
  }
}

function settingsScreen(c: { chatId: string; threadId?: number }): Screen {
  const p = prefsFor(c.chatId, c.threadId)
  const mark = (on: boolean, label: string) => `${on ? '• ' : ''}${label}`
  const where = c.threadId != null ? 'этом топике' : c.chatId.startsWith('-') ? 'General' : 'этой личке'
  const lines = [
    `⚙️ <b>Настройки в ${where}</b>`,
    `Подробность прогресса: ${verboseBadge(p.verbose)} ${VERBOSE_INFO[p.verbose]}`,
    `«✅ готово» после хода: ${NOTIFY_DONE_INFO[p.notifyDone]}`,
    `Ответы: ${VOICE_INFO[p.voice]}${ttsEnabled() ? '' : ' (синтез речи выключен)'}`,
    `Расшифровка голосовых в чате: ${p.transcript ? 'показывать' : 'не показывать'}${sttEnabled() ? '' : ' (распознавание выключено)'}`,
  ]
  const kb: Btn[][] = [
    ([0, 1, 2] as const).map(v => button(mark(p.verbose === v, verboseBadge(v)), `hub:v:${v}`, p.verbose === v ? 'primary' : undefined)),
    (['off', 'long', 'always'] as const).map(v => button(mark(p.notifyDone === v, `✅ ${v === 'long' ? 'долгие' : NOTIFY_DONE_INFO[v]}`), `hub:n:${v}`, p.notifyDone === v ? 'primary' : undefined)),
    (['off', 'mirror', 'always'] as const).map(v => button(mark(p.voice === v, `🔊 ${v === 'off' ? 'текст' : v === 'mirror' ? 'зеркально' : 'всегда'}`), `hub:vo:${v}`, p.voice === v ? 'primary' : undefined)),
    [button(mark(p.transcript, '🎤 показывать'), 'hub:tr:on', p.transcript ? 'primary' : undefined), button(mark(!p.transcript, '🎤 скрывать'), 'hub:tr:off', !p.transcript ? 'primary' : undefined)],
    [BACK()],
  ]
  return { text: lines.join('\n'), kb: new InlineKeyboard(kb as never) }
}

export function helpScreen(): Screen {
  const text = [
    '❓ <b>Помощь</b>',
    'Пишите в личку — отвечает ваша сессия Claude Code. В группе: топик = проект, General — пульт и ваша сессия.',
    '',
    '<b>Команды</b> (всё это есть и кнопками в /menu):',
    '/sessions — сессии, /topics — топики, /usage — лимиты',
    '/remind &lt;когда&gt; &lt;текст&gt; — напоминание (30m, 2h, 18:30, завтра 9:00, каждый день 9:00)',
    '/send &lt;топик&gt; &lt;текст&gt;, /broadcast &lt;текст&gt; — написать в сессии',
    '/remember — сохранить память чата, /forget — стереть историю',
    '/new_session &lt;имя|путь&gt; — новый проект',
    '',
    'Голосовые расшифровываются, ответы — голосом на голосовое (⚙️ Настройки чата).',
  ].join('\n')
  return { text, kb: new InlineKeyboard([[button('🎛 Меню', 'hub:main')]]) }
}

export function registerHubCommands(d: Daemon, bot: Bot): void {
  bot.command('menu', async ctx => {
    if (!ctx.from || !isOwner(ctx.from.id)) return
    const { text, kb } = mainScreen(d)
    const thread = ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb, message_thread_id: thread })
  })
}

/** hub:main|stats|people|rem|set|help|usage|digest|reports, hub:v|n|vo|tr:<value> */
export async function handleHubCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^hub:([a-z]+)(?::(\w+))?$/.exec(data)
  if (!m) return false
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: 'Нет доступа.' }).catch(() => {})
    return true
  }
  const [, action, value] = m
  const primary = String(ctx.from.id) === owner()
  let toast: string | undefined
  let screen: Screen
  switch (action) {
    case 'stats': screen = statsScreen(); break
    case 'people': screen = peopleScreen(d); break
    case 'rem': {
      const c = place(ctx)
      const r = remindersScreen(d, c.chatId, c.threadId)
      screen = { text: `${r.text}\n\nНовое: /remind 2h проверь CI`, kb: r.kb }
      break
    }
    case 'help': screen = helpScreen(); break
    case 'usage':
      if (!primary) { toast = 'Лимиты подписки видит только владелец.'; screen = statsScreen(); break }
      await ctx.answerCallbackQuery({ text: '📊 Собираю…' }).catch(() => {})
      await show(ctx, { text: await usageReport(d), kb: usageKeyboard(d) })
      return true
    case 'digest':
      await ctx.answerCallbackQuery({ text: '🌙 Собираю…' }).catch(() => {})
      await show(ctx, { text: await digestReport(d), kb: new InlineKeyboard([[button('« Статистика', 'hub:stats')]]) })
      return true
    case 'reports': screen = primary ? reportsScreen(d) : statsScreen(); if (!primary) toast = 'Отчёты — у владельца.'; break
    case 'set': screen = settingsScreen(place(ctx)); break
    case 'v': case 'n': case 'vo': case 'tr': {
      const c = place(ctx)
      const key = c.threadId != null ? `${c.chatId}:${c.threadId}` : c.chatId
      if (action === 'v' && ['0', '1', '2'].includes(value ?? '')) setPref(key, { verbose: Number(value) as 0 | 1 | 2 })
      if (action === 'n' && (value === 'off' || value === 'long' || value === 'always')) setPref(key, { notifyDone: value })
      if (action === 'vo' && (value === 'off' || value === 'mirror' || value === 'always')) setPref(key, { voice: value })
      if (action === 'tr' && (value === 'on' || value === 'off')) setPref(key, { transcript: value === 'on' })
      toast = 'Сохранено'
      screen = settingsScreen(c)
      break
    }
    default: screen = mainScreen(d)
  }
  await show(ctx, screen)
  await ctx.answerCallbackQuery(toast ? { text: toast } : undefined).catch(() => {})
  return true
}

