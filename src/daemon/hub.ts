/**
 * /menu: one message that leads everywhere — sessions, topics, statistics,
 * people, reminders, this chat's settings and help — so the command list in
 * Telegram stays short. Sections reuse the screens of /sessions, /topics,
 * /usage, /server, /users, /reports; each has a way back here.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { isOwner, loadAccess, NOTIFY_DONE_INFO, owner, prefsFor, setPref, verboseBadge, VERBOSE_INFO } from '../access.ts'
import { k, lang, LANG_NAMES, LANGS, normLang, t, withLang } from '../i18n/index.ts'
import { sttEnabled } from '../voice/stt.ts'
import { settings } from '../config.ts'
import { SILERO_VOICES, SPEEDS, ttsEnabled } from '../voice/tts.ts'
import type { Daemon } from './daemon.ts'
import { show, type Btn, type Screen } from './menu.ts'
import { macrosScreen } from './macros.ts'
import { fmtQuiet, QUIET_PRESETS, quietHours } from './quiet.ts'
import { remindersScreen } from './reminders.ts'
import { reportsScreen } from './reports.ts'
import { serverReport } from './server.ts'
import { button } from './stream.ts'
import { digestReport, limitsLine, usageKeyboard, usageReport } from './usage.ts'

const BACK = () => button(t('« Меню'), 'hub:main')
const VOICE_INFO = { off: k('текстом'), mirror: k('голосом на голосовое'), always: k('всегда голосом') } as const

/** Where the menu message lives: its chat and topic — the settings section is about it. */
function place(ctx: Context): { chatId: string; threadId?: number } {
  const m = ctx.callbackQuery?.message ?? ctx.message
  const threadId = m && 'is_topic_message' in m && m.is_topic_message ? m.message_thread_id : undefined
  return { chatId: String(ctx.chat!.id), threadId }
}

export function mainScreen(d: Daemon): Screen {
  const sessions = d.activeSessions()
  const lines = [t('🎛 <b>Меню</b>'), t('Сессий: {n}', { n: sessions.length }) + (d.permissions.size ? t(' · 🔐 ждут разрешения: {n}', { n: d.permissions.size }) : '')]
  const limits = limitsLine()
  if (limits) lines.push(limits)
  const kb: Btn[][] = [
    [button(t('📋 Сессии'), 'sm:list'), button(t('📂 Топики'), 'tm:list')],
    [button(t('📊 Статистика'), 'hub:stats'), button(t('👥 Люди'), 'hub:people')],
    [button(t('⏰ Напоминания'), 'hub:rem'), button(t('⚡ Быстрые команды'), 'hub:mc')],
    [button(t('⚙️ Настройки чата'), 'hub:set'), button(t('❓ Помощь'), 'hub:help')],
  ]
  return { text: lines.join('\n'), kb: new InlineKeyboard(kb as never) }
}

function statsScreen(): Screen {
  return {
    text: t('📊 <b>Статистика</b>\nЛимиты подписки и расход, итоги дня, отчёты за период с графиком, нагрузка сервера.'),
    kb: new InlineKeyboard([
      [button(t('📊 Лимиты и расход'), 'hub:usage'), button(t('🌙 Итоги дня'), 'hub:digest')],
      [button(t('📈 Отчёты'), 'hub:reports'), button(t('🖥 Сервер'), 'srv:refresh')],
      [BACK()],
    ]),
  }
}

function peopleScreen(d: Daemon): Screen {
  return {
    text: t('👥 <b>Люди</b>\nВ доступе: {n} · ждут разрешения: {p}', { n: loadAccess().allowFrom.length, p: d.permissions.size }),
    kb: new InlineKeyboard([
      [button(t('👥 Пользователи'), 'ur:list'), button(t('➕ Пригласить'), 'inv:start')],
      [button(t('🔐 Разрешения ({n})', { n: d.permissions.size }), 'sm:perms')],
      [BACK()],
    ]),
  }
}

function settingsScreen(d: Daemon, c: { chatId: string; threadId?: number }): Screen {
  const p = prefsFor(c.chatId, c.threadId)
  const mark = (on: boolean, label: string) => `${on ? '• ' : ''}${label}`
  const lines = [
    c.threadId != null ? t('⚙️ <b>Настройки в этом топике</b>') : c.chatId.startsWith('-') ? t('⚙️ <b>Настройки в General</b>') : t('⚙️ <b>Настройки в этой личке</b>'),
    t('Язык: {lang}', { lang: LANG_NAMES[normLang(p.lang) ?? lang()] }) + (p.lang ? '' : t(' (по умолчанию)')),
    t('Подробность прогресса: {badge} {info}', { badge: verboseBadge(p.verbose), info: t(VERBOSE_INFO[p.verbose]) }),
    t('«✅ готово» после хода: {v}', { v: t(NOTIFY_DONE_INFO[p.notifyDone]) }),
    t('Ответы: {v}', { v: t(VOICE_INFO[p.voice]) }) + (ttsEnabled() ? '' : t(' (синтез речи выключен)')),
    t('Расшифровка голосовых в чате: {v}', { v: p.transcript ? t('показывать') : t('не показывать') }) + (sttEnabled() ? '' : t(' (распознавание выключено)')),
  ]
  const silero = settings.ttsProvider === 'silero'
  if (ttsEnabled()) lines.push(t('Голос: {voice}скорость ×{speed}', { voice: silero ? `${p.ttsVoice || settings.ttsVoice}, ` : '', speed: p.ttsSpeed }))
  lines.push('', t('🌙 Тихие часы (для всего бота): {v} — в это время сообщения приходят без звука', { v: fmtQuiet(quietHours(d)) }))
  const cur = normLang(p.lang)
  const kb: Btn[][] = [
    LANGS.slice(0, 3).map(l => button(mark(cur === l, LANG_NAMES[l]), `hub:lg:${l}`, cur === l ? 'primary' : undefined)),
    LANGS.slice(3).map(l => button(mark(cur === l, LANG_NAMES[l]), `hub:lg:${l}`, cur === l ? 'primary' : undefined)),
    ([0, 1, 2] as const).map(v => button(mark(p.verbose === v, verboseBadge(v)), `hub:v:${v}`, p.verbose === v ? 'primary' : undefined)),
    (['off', 'long', 'always'] as const).map(v => button(mark(p.notifyDone === v, `✅ ${v === 'long' ? t('долгие') : t(NOTIFY_DONE_INFO[v])}`), `hub:n:${v}`, p.notifyDone === v ? 'primary' : undefined)),
    (['off', 'mirror', 'always'] as const).map(v => button(mark(p.voice === v, `🔊 ${v === 'off' ? t('текст') : v === 'mirror' ? t('зеркально') : t('всегда')}`), `hub:vo:${v}`, p.voice === v ? 'primary' : undefined)),
    [button(mark(p.transcript, t('🎤 показывать')), 'hub:tr:on', p.transcript ? 'primary' : undefined), button(mark(!p.transcript, t('🎤 скрывать')), 'hub:tr:off', !p.transcript ? 'primary' : undefined)],
  ]
  if (ttsEnabled()) {
    const voice = p.ttsVoice || settings.ttsVoice
    if (silero) kb.push(SILERO_VOICES.map(v => button(mark(voice === v, v), `hub:tv:${v}`, voice === v ? 'primary' : undefined)))
    kb.push(SPEEDS.map(v => button(mark(p.ttsSpeed === v, `×${v}`), `hub:ts:${Math.round(v * 100)}`, p.ttsSpeed === v ? 'primary' : undefined)))
  }
  const q = quietHours(d)
  kb.push(QUIET_PRESETS.map((v, i) => button(mark(q === v || (v === 'off' && fmtQuiet(q) === fmtQuiet('off')), `🌙 ${fmtQuiet(v)}`), `hub:qh:${i}`)))
  kb.push([BACK()])
  return { text: lines.join('\n'), kb: new InlineKeyboard(kb as never) }
}

export function helpScreen(): Screen {
  const text = [
    t('❓ <b>Помощь</b>'),
    t('Пишите в личку — отвечает ваша сессия Claude Code. В группе: топик = проект, General — пульт и ваша сессия.'),
    '',
    t('<b>Команды</b> (всё это есть и кнопками в /menu):'),
    t('/sessions — сессии, /topics — топики, /usage — лимиты'),
    t('/remind &lt;когда&gt; &lt;текст&gt; — напоминание (30m, 2h, 18:30, завтра 9:00, каждый день 9:00)'),
    t('/macro add &lt;кнопка&gt; | &lt;текст&gt; — быстрая команда чата (кнопки — /menu → ⚡)'),
    t('/send &lt;топик&gt; &lt;текст&gt;, /broadcast &lt;текст&gt; — написать в сессии'),
    t('/remember — сохранить память чата, /forget — стереть историю'),
    t('/new_session &lt;имя|путь&gt; — новый проект'),
    t('/lang — язык интерфейса в этом чате'),
    '',
    t('Голосовые расшифровываются, ответы — голосом на голосовое (⚙️ Настройки чата).'),
  ].join('\n')
  return { text, kb: new InlineKeyboard([[button(t('🎛 Меню'), 'hub:main')]]) }
}

export function registerHubCommands(d: Daemon, bot: Bot): void {
  bot.command('menu', async ctx => {
    if (!ctx.from || !isOwner(ctx.from.id)) return
    const { text, kb } = mainScreen(d)
    const thread = ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb, message_thread_id: thread })
  })

  // /lang [ru|en|es|zh|fr|de|auto]: the interface language of this chat (a topic follows its group unless set).
  bot.command('lang', async ctx => {
    if (!ctx.from || !isOwner(ctx.from.id) || !ctx.chat) return
    const c = place(ctx)
    const arg = String(ctx.match ?? '').trim().toLowerCase()
    const thread = c.threadId != null ? { message_thread_id: c.threadId } : {}
    const l = normLang(arg)
    if (!l && arg !== 'auto') {
      return void ctx.reply(t('Язык этого чата: {lang}\n/lang ru|en|es|zh|fr|de — выбрать, /lang auto — как в Telegram', { lang: LANG_NAMES[normLang(prefsFor(c.chatId, c.threadId).lang) ?? 'ru'] }), thread)
    }
    setPref(c.threadId != null ? `${c.chatId}:${c.threadId}` : c.chatId, { lang: l ?? undefined })
    await withLang(l ?? 'ru', () => ctx.reply(l ? t('Язык: {lang}', { lang: LANG_NAMES[l] }) : t('Язык: как в Telegram'), thread))
  })
}

/** hub:main|stats|people|rem|mc|set|help|usage|digest|reports, hub:v|n|vo|tr|tv|ts|qh|lg:<value> */
export async function handleHubCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^hub:([a-z]+)(?::(\w+))?$/.exec(data)
  if (!m) return false
  if (!ctx.from || !isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: t('Нет доступа.') }).catch(() => {})
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
      screen = { text: `${r.text}\n\n${t('Новое: /remind 2h проверь CI')}`, kb: r.kb }
      break
    }
    case 'help': screen = helpScreen(); break
    case 'mc': screen = macrosScreen(d, place(ctx)); break
    case 'usage':
      if (!primary) { toast = t('Лимиты подписки видит только владелец.'); screen = statsScreen(); break }
      await ctx.answerCallbackQuery({ text: t('📊 Собираю…') }).catch(() => {})
      await show(ctx, { text: await usageReport(d), kb: usageKeyboard(d) })
      return true
    case 'digest':
      await ctx.answerCallbackQuery({ text: t('🌙 Собираю…') }).catch(() => {})
      await show(ctx, { text: await digestReport(d), kb: new InlineKeyboard([[button(t('« Статистика'), 'hub:stats')]]) })
      return true
    case 'reports': screen = primary ? reportsScreen(d) : statsScreen(); if (!primary) toast = t('Отчёты — у владельца.'); break
    case 'set': screen = settingsScreen(d, place(ctx)); break
    case 'qh': {
      const v = QUIET_PRESETS[Number(value)]
      if (v) d.store.set('quiet_hours', v)
      toast = t('🌙 Тихие часы: {v}', { v: fmtQuiet(v ?? quietHours(d)) })
      screen = settingsScreen(d, place(ctx))
      break
    }
    case 'lg': {
      const c = place(ctx)
      const l = normLang(value)
      if (l) setPref(c.threadId != null ? `${c.chatId}:${c.threadId}` : c.chatId, { lang: l })
      // Answer in the new language right away.
      if (l) {
        await withLang(l, async () => {
          await show(ctx, settingsScreen(d, c))
          await ctx.answerCallbackQuery({ text: LANG_NAMES[l] }).catch(() => {})
        })
        return true
      }
      screen = settingsScreen(d, c)
      break
    }
    case 'v': case 'n': case 'vo': case 'tr': case 'tv': case 'ts': {
      const c = place(ctx)
      const key = c.threadId != null ? `${c.chatId}:${c.threadId}` : c.chatId
      if (action === 'v' && ['0', '1', '2'].includes(value ?? '')) setPref(key, { verbose: Number(value) as 0 | 1 | 2 })
      if (action === 'n' && (value === 'off' || value === 'long' || value === 'always')) setPref(key, { notifyDone: value })
      if (action === 'vo' && (value === 'off' || value === 'mirror' || value === 'always')) setPref(key, { voice: value })
      if (action === 'tr' && (value === 'on' || value === 'off')) setPref(key, { transcript: value === 'on' })
      if (action === 'tv' && (SILERO_VOICES as readonly string[]).includes(value ?? '')) setPref(key, { ttsVoice: value })
      if (action === 'ts' && SPEEDS.some(v => Math.round(v * 100) === Number(value))) setPref(key, { ttsSpeed: Number(value) / 100 })
      toast = t('Сохранено')
      screen = settingsScreen(d, c)
      break
    }
    default: screen = mainScreen(d)
  }
  await show(ctx, screen)
  await ctx.answerCallbackQuery(toast ? { text: toast } : undefined).catch(() => {})
  return true
}

