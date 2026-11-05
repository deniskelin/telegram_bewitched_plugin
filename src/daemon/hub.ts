import { lastResult } from './ux.ts'
import { sessionShortName } from './report.ts'
/**
 * /menu: one message that leads everywhere — sessions, topics, statistics,
 * people, reminders, this chat's settings and help — so the command list in
 * Telegram stays short. Sections reuse the screens of /sessions, /topics,
 * /usage, /server, /users, /reports; each has a way back here.
 */

import { resolveTarget } from './inbound.ts'
import { pauseBadge } from './outoftokens.ts'
import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { can, loadAccess, NOTIFY_DONE_INFO, owner, prefsFor, setPref, verboseBadge, VERBOSE_INFO } from '../access.ts'
import { k, lang, LANG_NAMES, LANGS, normLang, t, withLang } from '../i18n/index.ts'
import { sttEnabled } from '../voice/stt.ts'
import { settings } from '../config.ts'
import { SILERO_VOICES, SPEEDS, ttsEnabled } from '../voice/tts.ts'
import type { Daemon } from './daemon.ts'
import { show, modelScreen, type Btn, type Screen } from './menu.ts'
import { macrosScreen } from './macros.ts'
import { fmtQuiet, QUIET_PRESETS, quietHours } from './quiet.ts'
import { remindersScreen } from './reminders.ts'
import { reportsScreen } from './reports.ts'
import { serverReport } from './server.ts'
import { button, urlButton } from './stream.ts'
import { limitsLine, usageScreen, usagePeriod } from './usage.ts'
import { sendDaily, todaySoFar } from './daily.ts'
import { idleScreen } from './idle.ts'

const BACK = () => button(t('« Меню'), 'hub:main')
const ANSWER_INFO = { short: k('Кратко'), normal: k('Обычно'), detailed: k('Подробно') } as const
const VOICE_INFO = { off: k('текстом'), mirror: k('голосом на голосовое'), always: k('всегда голосом') } as const

/** Where the menu message lives: its chat and topic — the settings section is about it. */
function place(ctx: Context): { chatId: string; threadId?: number } {
  const m = ctx.callbackQuery?.message ?? ctx.message
  const threadId = m && 'is_topic_message' in m && m.is_topic_message ? m.message_thread_id : undefined
  return { chatId: String(ctx.chat!.id), threadId }
}

export function mainScreen(d: Daemon, c?:{chatId:string;threadId?:number}, more=false): Screen {
  const sessions = d.activeSessions()
  const lines = [t('🎛 <b>Меню</b>'), t('Сессий: {n}', { n: sessions.length }) + (d.permissions.size ? t(' · 🔐 ждут разрешения: {n}', { n: d.permissions.size }) : '')]
  const limits = limitsLine()
  if (limits) lines.push(limits)
  const pause = pauseBadge(d)
  if (pause) lines.push(pause)
  const own=owner()?d.userSession?.(owner()!):null
  lines.push(own?`${t('Ваша сессия')}: ${own.engine==='codex'?'Codex':'Claude'} · ${own.status==='idle'?t('свободна'):own.status==='waiting'?t('ждёт разрешения'):t('работает')}`:`${t('Ваша сессия')}: ⏻ ${t('не запущена')}`)
  if(c&&owner()){const target=resolveTarget(d,{...c,isPrivate:!c.chatId.startsWith('-')},owner()!);if(target.kind==='session')lines.push(`${t('Этот чат')}: ${sessionShortName(d,target.session)}`)}
  if(!more){
    const actions:Btn[][]=[]
    if(d.permissions.size)actions.push([button(t('🔐 Разрешения ({size})',{size:d.permissions.size}),'sm:perms')])
    for(const s of sessions.filter(s=>s.turn?.stuck||s.stopRequest?.phase==='failed'||d.store.get(`ux:error:${s.projectKey}`)).slice(0,2))actions.push([button(`${t('Требуют внимания')}: ${sessionShortName(d,s)}`,`sm:s:${s.id}`)])
    const unread=sessions.filter(s=>lastResult(d,s.projectKey)?.unread)
    if(unread.length)actions.push([button(`${t('Непрочитанный результат')}: ${unread.length}`,'sl:attention')])
    if(pause)actions.push([button(t('▶️ Продолжить сейчас'),'tok:go')])
    return{text:lines.join('\n'),kb:new InlineKeyboard([...actions,[button(t('📋 Сессии'),'sm:list'),button(t('Лимиты'),'hub:usage'),button(t('Отчёты'),'hub:periods')],[button(t('Новая задача'),'tk:list'),button(t('Дополнительно'),'hub:more')]] as never)}
  }
  const kb: Btn[][] = [
    ...(pause ? [[button(t('▶️ Продолжить сейчас'), 'tok:go')]] : []),
    [button(t('📋 Сессии'), 'sm:list'), button(t('📂 Топики'), 'tm:list'), button(t('👥 Группы'), 'gp:list')],
    [button(t('📊 Статистика'), 'hub:stats'), button(t('👥 Люди'), 'hub:people')],
    [button(t('⏰ Напоминания'), 'hub:rem'), button(t('⚡ Быстрые команды'), 'hub:mc')],
    [button(t('⚙️ Настройки чата'), 'hub:set'), button(t('🧠 Настройки агента'), 'hub:agent')],
    [button(t('Новая задача'), 'tk:list'), button(t('💤 Приостановка сессий'), 'hub:idle')],
    [button(t('❓ Помощь'), 'hub:help'), BACK()],
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

export function settingsScreen(d: Daemon, c: { chatId: string; threadId?: number }): Screen {
  const p = prefsFor(c.chatId, c.threadId)
  const mark = (on: boolean, label: string) => `${on ? '• ' : ''}${label}`
  const cur = normLang(p.lang)
  const lines = [
    c.threadId != null ? t('⚙️ <b>Настройки в этом топике</b>') : c.chatId.startsWith('-') ? t('⚙️ <b>Настройки в General</b>') : t('⚙️ <b>Настройки в этой личке</b>'),
    t('Изменения применяются сразу.'),
    t('Язык: {lang}', { lang: LANG_NAMES[cur ?? lang()] }) + (p.lang ? '' : t(' (по умолчанию)')),
    t('Подробность ответа: {detail}', { detail: t(ANSWER_INFO[p.answerDetail]) }),
    t('Подробность прогресса: {badge} {info}', { badge: verboseBadge(p.verbose), info: t(VERBOSE_INFO[p.verbose]) }),
    t('Ответы: {v}', { v: t(VOICE_INFO[p.voice]) }) + (ttsEnabled() ? '' : t(' (синтез речи выключен)')),
    t('Расшифровка голосовых в чате: {v}', { v: p.transcript ? t('показывать') : t('не показывать') }) + (sttEnabled() ? '' : t(' (распознавание выключено)')),
  ]
  const kb: Btn[][] = [
    LANGS.slice(0, 3).map(l => button(mark(cur === l, LANG_NAMES[l]), `hub:lg:${l}`, cur === l ? 'primary' : undefined)),
    LANGS.slice(3).map(l => button(mark(cur === l, LANG_NAMES[l]), `hub:lg:${l}`, cur === l ? 'primary' : undefined)),
    (['short', 'normal', 'detailed'] as const).map(v => button(mark(p.answerDetail === v, t(ANSWER_INFO[v])), `hub:ad:${v}`, p.answerDetail === v ? 'primary' : undefined)),
    ([0, 1, 2] as const).map(v => button(mark(p.verbose === v, verboseBadge(v)), `hub:v:${v}`, p.verbose === v ? 'primary' : undefined)),
    (['off', 'mirror', 'always'] as const).map(v => button(mark(p.voice === v, `🔊 ${v === 'off' ? t('текст') : v === 'mirror' ? t('зеркально') : t('всегда')}`), `hub:vo:${v}`, p.voice === v ? 'primary' : undefined)),
    [button(mark(p.transcript, t('🎤 показывать')), 'hub:tr:on', p.transcript ? 'primary' : undefined), button(mark(!p.transcript, t('🎤 скрывать')), 'hub:tr:off', !p.transcript ? 'primary' : undefined)],
  ]
  if (ttsEnabled()) {
    const voice = p.ttsVoice || settings.ttsVoice
    lines.push(t('Голос: {voice}скорость ×{speed}', { voice: `${voice}, `, speed: p.ttsSpeed }))
    if (settings.ttsProvider === 'silero') kb.push(SILERO_VOICES.map(v => button(mark(voice === v, v), `hub:tv:${v}`, voice === v ? 'primary' : undefined)))
    kb.push(SPEEDS.map(v => button(mark(p.ttsSpeed === v, `×${v}`), `hub:ts:${Math.round(v * 100)}`, p.ttsSpeed === v ? 'primary' : undefined)))
  }
  kb.push([button(t('🧠 Настройки агента'), 'hub:agent'), button(t('Дополнительно'), 'hub:advanced')], [BACK()])
  return { text: lines.join('\n'), kb: new InlineKeyboard(kb as never) }
}

export function advancedSettingsScreen(d: Daemon, c: { chatId: string; threadId?: number }): Screen {
  const p = prefsFor(c.chatId, c.threadId)
  const mark = (on: boolean, label: string) => `${on ? '• ' : ''}${label}`
  const q = quietHours(d)
  const lines = [
    `<b>${t('Дополнительно')}</b>`, t('Изменения применяются сразу.'),
    t('Ответ: {v}', { v: p.streamAnswer ? t('пишется на глазах') : t('приходит целиком') }),
    t('Конец ответа в группе: {v}', { v: p.streamFinal === 'edit' ? t('правкой того же сообщения, без звука') : t('новым сообщением, со звуком') }),
    t('«✅ готово» после хода: {v}', { v: t(NOTIFY_DONE_INFO[p.notifyDone]) }),
    t('🌙 Тихие часы (для всего бота): {v} — в это время сообщения приходят без звука', { v: fmtQuiet(q) }),
  ]
  const kb: Btn[][] = [
    [button(mark(p.streamAnswer, t('✍️ на глазах')), 'hub:sa:on', p.streamAnswer ? 'primary' : undefined), button(mark(!p.streamAnswer, t('📦 целиком')), 'hub:sa:off', !p.streamAnswer ? 'primary' : undefined)],
    [button(mark(p.streamFinal === 'edit', t('✏️ конец: правкой')), 'hub:sf:edit', p.streamFinal === 'edit' ? 'primary' : undefined), button(mark(p.streamFinal === 'new', t('🆕 конец: новым')), 'hub:sf:new', p.streamFinal === 'new' ? 'primary' : undefined)],
    (['off', 'long', 'always'] as const).map(v => button(mark(p.notifyDone === v, `✅ ${v === 'long' ? t('долгие') : t(NOTIFY_DONE_INFO[v])}`), `hub:n:${v}`, p.notifyDone === v ? 'primary' : undefined)),
    [button(mark(!p.turnCost, t('🔢 расход: скрыт')), 'hub:tc:off', !p.turnCost ? 'primary' : undefined), button(mark(p.turnCost, t('🔢 после каждого хода')), 'hub:tc:on', p.turnCost ? 'primary' : undefined)],
    QUIET_PRESETS.map((v, i) => button(mark(q === v, `🌙 ${fmtQuiet(v)}`), `hub:qh:${i}`)),
    [button(t('⚙️ Настройки чата'), 'hub:set'), BACK()],
  ]
  return { text: lines.join('\n'), kb: new InlineKeyboard(kb as never) }
}

export function helpScreen(): Screen {
  const lines = [
    t('❓ <b>Помощь</b>'),
    t('Пишите в личку — отвечает ваша сессия Claude Code. В группе: топик = проект, General — пульт и ваша сессия.'),
    '',
    t('<b>Команды</b> (всё это есть и кнопками в /menu):'),
    t('/sessions — сессии, /topics — топики, /usage — лимиты'),
    t('/task — выбрать тип следующей задачи'),
    t('/economy — экономия; fast/balanced/thorough [модель] — профиль следующего запуска'),
    t('/remind &lt;когда&gt; &lt;текст&gt; — напоминание (30m, 2h, 18:30, завтра 9:00, каждый день 9:00)'),
    t('/macro add &lt;кнопка&gt; | &lt;текст&gt; — быстрая команда чата (кнопки — /menu → ⚡)'),
    t('/send &lt;топик&gt; &lt;текст&gt;, /broadcast &lt;текст&gt; — написать в сессии'),
    t('/remember — сохранить память чата, /forget — стереть историю'),
    t('/new_session &lt;имя|путь&gt; — новый проект'),
    t('Обычная группа (без топиков) тоже может быть проектом: разрешите её через access, бот пришлёт вам карточку — /menu → 👥 Группы'),
    t('/lang — язык интерфейса в этом чате'),
    t('/prompt [текст|off] — режим промпта топика: обычный, ревью, собеседник или свой'),
    t('/once [claude|codex] &lt;вопрос&gt; — разовый ход без сессии (только чтение), /review — ревью изменений другой моделью'),
    '',
    t('Голосовые расшифровываются, ответы — голосом на голосовое (⚙️ Настройки чата).'),
  ]
  const author = settings.authorContact
  const rows: Btn[][] = []
  if (author) {
    lines.push('', t('💌 Связаться с автором и предложить улучшение:'))
    const links: Btn[] = []
    if (author.telegram) links.push(urlButton(t('✈️ Написать автору'), author.telegram))
    if (author.issues) links.push(urlButton(t('🐞 GitHub Issues'), author.issues))
    if (links.length) rows.push(links)
  }
  rows.push([button(t('🎛 Меню'), 'hub:main')])
  return { text: lines.join('\n'), kb: new InlineKeyboard(rows as never) }
}

export function registerHubCommands(d: Daemon, bot: Bot): void {
  bot.command('menu', async ctx => {
    if (!ctx.from || !can(ctx.from.id, 'control')) return
    const { text, kb } = mainScreen(d,place(ctx))
    const thread = ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb, message_thread_id: thread })
  })

  // /lang [ru|en|es|zh|fr|de|auto]: the interface language of this chat (a topic follows its group unless set).
  bot.command('lang', async ctx => {
    if (!ctx.from || !can(ctx.from.id, 'control') || !ctx.chat) return
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

/** hub:main|stats|people|rem|mc|set|help|usage|digest|reports, hub:v|n|vo|tr|tv|ts|sa|sf|qh|lg:<value> */
export async function handleHubCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^hub:([a-z]+)(?::(\w+))?$/.exec(data)
  if (!m) return false
  if (!ctx.from || !can(ctx.from.id, 'control')) {
    await ctx.answerCallbackQuery({ text: t('Нет доступа.') }).catch(() => {})
    return true
  }
  const [, action, value] = m
  const primary = String(ctx.from.id) === owner()
  let toast: string | undefined
  let screen: Screen
  switch (action) {
    case 'more': screen=mainScreen(d,place(ctx),true);break
    case 'periods': await ctx.answerCallbackQuery().catch(()=>{});await show(ctx,await usageScreen(d,place(ctx)));return true
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
      await show(ctx,await usageScreen(d,place(ctx),usagePeriod(d),Date.now(),'current',undefined,'limits'))
      return true
    case 'digest':
      // The day so far, as the 00:00 summary: a new rich message under the menu.
      await ctx.answerCallbackQuery({ text: t('🌙 Собираю…') }).catch(() => {})
      if (ctx.chat) await sendDaily(d, String(ctx.chat.id), todaySoFar(), ctx.callbackQuery?.message?.message_thread_id)
      return true
    case 'reports': screen = primary ? reportsScreen(d) : statsScreen(); if (!primary) toast = t('Отчёты — у владельца.'); break
    case 'agent': {
      const c = place(ctx)
      const target = resolveTarget(d, { ...c, isPrivate: !c.chatId.startsWith('-') }, String(ctx.from.id))
      if (target.kind === 'session') screen = await modelScreen(d, target.session)
      else if (target.kind === 'user_offline' && target.userId === owner()) { await ctx.answerCallbackQuery().catch(() => {}); const { handleSessionMenu } = await import('./menu.ts'); await handleSessionMenu(d, ctx, 'sm:owner'); return true }
      else { toast = t('Сначала запустите сессию.'); screen = mainScreen(d,place(ctx)) }
      break
    }
    case 'advanced': screen = advancedSettingsScreen(d, place(ctx)); break
    case 'set': screen = settingsScreen(d, place(ctx)); break
    case 'idle': screen = primary ? idleScreen(d) : mainScreen(d,place(ctx)); if (!primary) toast = t('Это настройка владельца.'); break
    case 'qh': {
      const v = QUIET_PRESETS[Number(value)]
      if (v) d.store.set('quiet_hours', v)
      toast = t('🌙 Тихие часы: {v}', { v: fmtQuiet(v ?? quietHours(d)) })
      screen = advancedSettingsScreen(d, place(ctx))
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
    case 'ad': case 'v': case 'n': case 'vo': case 'tr': case 'tv': case 'ts': case 'sa': case 'sf': case 'tc': {
      const c = place(ctx)
      const key = c.threadId != null ? `${c.chatId}:${c.threadId}` : c.chatId
      if (action === 'ad' && (value === 'short' || value === 'normal' || value === 'detailed')) setPref(key, { answerDetail: value })
      if (action === 'v' && ['0', '1', '2'].includes(value ?? '')) setPref(key, { verbose: Number(value) as 0 | 1 | 2 })
      if (action === 'n' && (value === 'off' || value === 'long' || value === 'always')) setPref(key, { notifyDone: value })
      if (action === 'vo' && (value === 'off' || value === 'mirror' || value === 'always')) setPref(key, { voice: value })
      if (action === 'tr' && (value === 'on' || value === 'off')) setPref(key, { transcript: value === 'on' })
      if (action === 'sa' && (value === 'on' || value === 'off')) setPref(key, { streamAnswer: value === 'on' })
      if (action === 'sf' && (value === 'edit' || value === 'new')) setPref(key, { streamFinal: value })
      if (action === 'tc' && (value === 'on' || value === 'off')) setPref(key, { turnCost: value === 'on' })
      if (action === 'tv' && (SILERO_VOICES as readonly string[]).includes(value ?? '')) setPref(key, { ttsVoice: value })
      if (action === 'ts' && SPEEDS.some(v => Math.round(v * 100) === Number(value))) setPref(key, { ttsSpeed: Number(value) / 100 })
      toast = t('Сохранено')
      screen = ['n', 'sa', 'sf', 'tc'].includes(action) ? advancedSettingsScreen(d, c) : settingsScreen(d, c)
      break
    }
    default: screen = mainScreen(d,place(ctx))
  }
  await show(ctx, screen)
  await ctx.answerCallbackQuery(toast ? { text: toast } : undefined).catch(() => {})
  return true
}

