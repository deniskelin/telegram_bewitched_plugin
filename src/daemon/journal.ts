/**
 * Journal: with JOURNAL_CHAT_ID set, the daemon's informational notices go to
 * that group, each kind into its own topic (created on first use; the
 * group's General when it has no topics). What waits for the owner — a
 * permission, a launch to confirm, a user's request, a reminder they asked
 * for — stays in the owner's DM. A few events are logged only there: the bot
 * added to or removed from a group, a message from someone who is not a user.
 * Without JOURNAL_CHAT_ID every notice goes to the owner's DM as before.
 */

import type { Message } from 'grammy/types'
import { owner } from '../access.ts'
import { settings } from '../config.ts'
import { escapeHtml } from '../format.ts'
import { k, t } from '../i18n/index.ts'
import type { Daemon } from './daemon.ts'
import { inChat } from './lang.ts'

/** The journal's topics. */
export type JournalTopic = 'access' | 'sessions' | 'limits' | 'reports' | 'daemon'

const TOPIC_NAME: Record<JournalTopic, string> = {
  access: k('🛡 Доступ'),
  sessions: k('🖥 Сессии'),
  limits: k('📊 Лимиты'),
  reports: k('📰 Отчёты'),
  daemon: k('⚙️ Демон'),
}

/** Chats where creating a topic failed (no topics, no rights): General there, until a restart. */
const noTopics = new Set<string>()

async function topicThread(d: Daemon, chat: string, topic: JournalTopic): Promise<number | undefined> {
  const key = `journal_topic:${chat}:${topic}`
  const known = Number(d.store.get(key))
  if (known) return known
  if (noTopics.has(chat)) return undefined
  try {
    const t2 = await d.bot.api.createForumTopic(chat, inChat(d, chat, undefined, () => t(TOPIC_NAME[topic])))
    d.store.set(key, String(t2.message_thread_id))
    return t2.message_thread_id
  } catch (err) {
    d.log(`journal topic ${topic}: ${err}`)
    noTopics.add(chat)
    return undefined
  }
}

/**
 * The journal group: JOURNAL_CHAT_ID, followed to its new id when Telegram
 * turned the group into a supergroup (topics switched on → migrate_to_chat_id).
 */
export function journalChat(d: Daemon): string | null {
  const id = settings.journalChatId
  return id ? d.store.get(`chat_migrated:${id}`) ?? id : null
}

/** A group became a supergroup with a new id: the journal follows it. */
export function onChatMigrated(d: Daemon, from: string, to: string): void {
  if (from !== journalChat(d)) return
  d.store.set(`chat_migrated:${settings.journalChatId}`, to)
  d.log(`journal moved: ${from} → ${to}`)
}

/** Where a notice of this kind goes: the journal's topic, else the owner's DM. */
export async function noticeTarget(d: Daemon, topic: JournalTopic): Promise<{ chat: string; thread?: number } | null> {
  const j = journalChat(d)
  if (j) return { chat: j, thread: await topicThread(d, j, topic) }
  const o = owner()
  return o ? { chat: o } : null
}

type Extra = Omit<NonNullable<Parameters<Daemon['bot']['api']['sendMessage']>[2]>, 'message_thread_id'>

/**
 * Send a notice: text and keyboard are built in the target chat's language.
 * A topic deleted by hand is created again once.
 */
export async function sendNotice(d: Daemon, topic: JournalTopic, text: () => string, extra: () => Extra = () => ({})): Promise<{ msg: Message.TextMessage; chat: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const to = await noticeTarget(d, topic)
    if (!to) return null
    try {
      const msg = await inChat(d, to.chat, to.thread, () => d.bot.api.sendMessage(to.chat, text(), { parse_mode: 'HTML', ...extra(), ...(to.thread != null ? { message_thread_id: to.thread } : {}) }))
      return { msg, chat: to.chat }
    } catch (err) {
      if (to.thread != null && /thread not found|TOPIC_DELETED|TOPIC_CLOSED/i.test(String(err))) {
        d.store.set(`journal_topic:${to.chat}:${topic}`, null)
        continue
      }
      d.log(`notice (${topic}) failed: ${err}`)
      return null
    }
  }
  return null
}

/** Log an event that only the journal hears of; nothing without one. */
export async function journal(d: Daemon, topic: JournalTopic, text: () => string): Promise<void> {
  if (!journalChat(d)) return
  await sendNotice(d, topic, text, () => ({ link_preview_options: { is_disabled: true } }))
}

/** «Name (@user, id)» of a Telegram sender, escaped. */
export function who(from: { id: number; first_name?: string; last_name?: string; username?: string }): string {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ')
  const tail = [name && from.username ? `@${from.username}` : null, from.id].filter(Boolean).join(', ')
  return escapeHtml(`${name || (from.username ? `@${from.username}` : '')} (${tail})`.trim())
}

export const journalText = {
  added: (title: string, chat: string, by: string) => t('➕ Бота добавили в группу «{title}» (<code>{chat}</code>) — {by}.', { title: escapeHtml(title), chat, by }),
  removed: (title: string, chat: string, by: string) => t('➖ Бота исключили из группы «{title}» (<code>{chat}</code>) — {by}.', { title: escapeHtml(title), chat, by }),
  stranger: (from: string, where: string, text: string) => t('✉️ Написал(а) не пользователь: {from}{where}\n<blockquote>{text}</blockquote>', { from, where, text: escapeHtml(text.slice(0, 1000)) }),
}
