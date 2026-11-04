/**
 * FR-20: a prompt mode per topic (project folder). The mode adds a system
 * prompt and limits the tools of the session's next launch:
 *   default — as is;
 *   review  — reads and comments, never changes files;
 *   chat    — a conversation partner: no shell, no file edits;
 *   custom  — the owner's own text (/prompt <text>), tools as is.
 * Claude Code gets --append-system-prompt (read from a file the daemon writes,
 * never from chat text on the command line) and --disallowedTools; Codex a
 * profile of its own with the text added to its instructions and a read-only
 * sandbox for review and chat. A running session keeps its mode until ♻️.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { createHash } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { can } from '../access.ts'
import { STATE_DIR } from '../config.ts'
import { clip, escapeHtml } from '../format.ts'
import { k, t } from '../i18n/index.ts'
import type { Daemon } from './daemon.ts'
import { button } from './stream.ts'

export type Preset = 'default' | 'review' | 'chat' | 'custom'
export type PromptMode = { preset: Preset; text?: string }

const PRESETS: Preset[] = ['default', 'review', 'chat', 'custom']

const LABELS: Record<Preset, string> = {
  default: k('💻 Обычный'),
  review: k('🔍 Ревью (только чтение)'),
  chat: k('💬 Собеседник (без инструментов)'),
  custom: k('✏️ Свой промпт'),
}

/** Text for the model: not translated. */
const PRESET_TEXT: Record<Exclude<Preset, 'default' | 'custom'>, string> = {
  review: 'Mode for this topic: REVIEW. Read code with the file tools and explain; the shell and the editing tools are switched off here. Never modify files, commit or push by any other means. Point at problems with file:line and suggest fixes as text.', // i18n-ignore
  chat: 'Mode for this topic: CONVERSATION. Be a thoughtful conversation partner: answer from knowledge and the chat history. Do not run shell commands or edit files.', // i18n-ignore
}

/**
 * Claude Code tools a preset takes away. F02: review has no shell either — a deny rule beats any allow rule
 * the user's settings carry, so «read only» does not rest on the model's word. The bridge's own MCP stays
 * (the session answers through it); other MCP servers are not limited by this.
 */
const DISALLOWED: Partial<Record<Preset, string[]>> = {
  review: ['Bash', 'Edit', 'Write', 'NotebookEdit'],
  chat: ['Bash', 'Edit', 'Write', 'NotebookEdit'],
}

export function promptMode(d: Daemon, dir: string): PromptMode {
  try {
    const v = JSON.parse(d.store.get(`prompt:${dir}`) ?? '') as PromptMode
    if (PRESETS.includes(v.preset)) return v.preset === 'custom' && !v.text?.trim() ? { preset: 'default' } : v
  } catch {}
  return { preset: 'default' }
}

export function setPromptMode(d: Daemon, dir: string, m: PromptMode): void {
  d.store.set(`prompt:${dir}`, m.preset === 'default' ? null : JSON.stringify(m))
}

export type LaunchPrompt = { file: string; disallowed: string[]; readOnly: boolean; key: string }

/** What a launch in dir adds for its mode: the prompt file (written now), tools to take away. Null for the default mode. */
export function launchPrompt(d: Daemon, dir: string): LaunchPrompt | null {
  const m = promptMode(d, dir)
  if (m.preset === 'default') return null
  const text = m.preset === 'custom' ? m.text!.trim() : PRESET_TEXT[m.preset]
  const key = createHash('sha1').update(`${dir}\n${m.preset}\n${text}`).digest('hex').slice(0, 12)
  const folder = join(STATE_DIR, 'prompts')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = join(folder, `${key}.md`)
  writeFileSync(file, text + '\n', { mode: 0o600 })
  return { file, disallowed: DISALLOWED[m.preset] ?? [], readOnly: m.preset === 'review' || m.preset === 'chat', key }
}

function where(ctx: Context): { chatId: string; threadId?: number } {
  const m = ctx.callbackQuery?.message ?? ctx.message
  const threadId = m && 'is_topic_message' in m && m.is_topic_message ? m.message_thread_id : undefined
  return { chatId: String(ctx.chat!.id), threadId }
}

/** The project folder a chat/topic belongs to, or null. */
function dirOf(d: Daemon, c: { chatId: string; threadId?: number }): string | null {
  if (c.threadId != null) return d.store.topic(c.chatId, c.threadId)?.project_key ?? null
  return null
}

export function promptScreen(d: Daemon, dir: string): { text: string; kb: InlineKeyboard } {
  const m = promptMode(d, dir)
  const lines = [
    t('🎭 <b>Режим промпта</b> · <code>{dir}</code>', { dir: escapeHtml(dir) }),
    t('Сейчас: {mode}', { mode: t(LABELS[m.preset]) }),
  ]
  if (m.preset === 'custom' && m.text) lines.push(`<blockquote>${escapeHtml(clip(m.text, 600))}</blockquote>`)
  lines.push('', t('Свой промпт: /prompt &lt;текст&gt;, обычный: /prompt off.'), t('<i>Действует со следующего запуска сессии (♻️ в карточке сессии).</i>'))
  const s = d.activeSessions().find(x => x.cwd === dir || x.projectKey === dir)
  const kb = new InlineKeyboard([
    ...(['default', 'review', 'chat'] as const).map(p => [button(`${m.preset === p ? '• ' : ''}${t(LABELS[p])}`, `pm:set:${p}`, m.preset === p ? 'primary' : undefined)]),
    ...(s ? [[button(t('♻️ Перезапустить сессию сейчас'), `sm:engre:${s.id}`)]] : []),
  ])
  return { text: lines.join('\n'), kb }
}

export function registerPromptCommands(d: Daemon, bot: Bot): void {
  // /prompt [text|off] in a project topic.
  bot.command('prompt', async ctx => {
    if (!ctx.from || !can(ctx.from.id, 'control') || !ctx.chat) return
    const c = where(ctx)
    const thread = c.threadId != null ? { message_thread_id: c.threadId } : {}
    const dir = dirOf(d, c)
    if (!dir) return void ctx.reply(t('Режим промпта задаётся в топике проекта.'), thread)
    const arg = String(ctx.match ?? '').trim()
    if (arg) {
      if (/^(off|default|сброс|обычный)$/i.test(arg)) setPromptMode(d, dir, { preset: 'default' }) // i18n-ignore
      else setPromptMode(d, dir, { preset: 'custom', text: arg.slice(0, 4000) })
      d.log(`prompt mode of ${dir}: ${promptMode(d, dir).preset}`)
    }
    const sc = promptScreen(d, dir)
    await ctx.reply(sc.text, { parse_mode: 'HTML', reply_markup: sc.kb, ...thread })
  })
}

/** pm:set:<preset> */
export async function handlePromptCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^pm:set:(default|review|chat)$/.exec(data)
  if (!m) return false
  if (!ctx.from || !can(ctx.from.id, 'control') || !ctx.chat) {
    await ctx.answerCallbackQuery({ text: t('Нет доступа.') }).catch(() => {})
    return true
  }
  const dir = dirOf(d, where(ctx))
  if (!dir) {
    await ctx.answerCallbackQuery({ text: t('Режим промпта задаётся в топике проекта.') }).catch(() => {})
    return true
  }
  setPromptMode(d, dir, { preset: m[1] as Preset })
  d.log(`prompt mode of ${dir}: ${m[1]}`)
  await ctx.answerCallbackQuery({ text: t(LABELS[m[1] as Preset]) }).catch(() => {})
  const sc = promptScreen(d, dir)
  await ctx.editMessageText(sc.text, { parse_mode: 'HTML', reply_markup: sc.kb }).catch(() => {})
  return true
}
