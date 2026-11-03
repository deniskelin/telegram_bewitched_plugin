/**
 * FR-17: one-shot turns, without a session.
 *   /once [claude|codex] <text> — one turn in the topic's folder: `claude -p
 *     --output-format stream-json` or `codex exec --json`, read-only; the
 *     answer is posted to the chat. The running session (if any) is not
 *     touched and its context is not spent.
 *   «🔍 Ревью другой моделью» (session card, /review) — the other engine
 *     reviews the session's uncommitted changes against its last task.
 */

import type { Bot, Context } from 'grammy'
import { spawn } from 'child_process'
import { can } from '../access.ts'
import { settings } from '../config.ts'
import { clip, maskSecrets } from '../format.ts'
import { t } from '../i18n/index.ts'
import { sendRich } from '../tg.ts'
import type { ChatRef, Daemon, Session } from './daemon.ts'
import { codexBin, engineOf, ENGINES, projectEngine, type EngineId } from './engines.ts'
import { gitDiff } from './git.ts'
import { sessionTranscript, turnsOf } from './handoff.ts'
import { button } from './stream.ts'

export type OnceResult = { ok: boolean; text: string; ms: number }

/** Read-only tools for a one-shot Claude turn: it may look, not change. */
const CLAUDE_READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git status:*)', 'Bash(git show:*)']

/** The command line of a one-shot turn. Never through a shell: the prompt is one argv item. */
export function onceArgv(engine: EngineId, prompt: string, model?: string): { bin: string; args: string[] } | null {
  if (engine === 'claude') {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--allowedTools', CLAUDE_READ_TOOLS.join(','), '--disallowedTools', 'Edit,Write,NotebookEdit']
    if (model && /^[\w.-]+$/.test(model)) args.push('--model', model)
    return { bin: settings.claudeBin, args }
  }
  const bin = codexBin()
  if (!bin) return null
  const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check']
  if (model && /^[\w.-]+$/.test(model)) args.push('-m', model)
  args.push(prompt)
  return { bin, args }
}

/** The answer from the JSON lines of either CLI: Claude's result event, else Codex's last agent message. */
export function parseOnceOutput(out: string): { text: string; error?: string } {
  let result: string | null = null
  let lastAgent: string | null = null
  let error: string | undefined
  for (const line of out.split('\n')) {
    const l = line.trim()
    if (!l.startsWith('{')) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(l) } catch { continue }
    // Claude Code stream-json: {"type":"result","subtype":"success","result":"…","is_error":false}
    if (e.type === 'result') {
      if (typeof e.result === 'string') result = e.result
      if (e.is_error === true) error = typeof e.result === 'string' ? e.result : String(e.subtype ?? 'error')
    }
    // Codex exec --json: {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
    const item = e.item as Record<string, unknown> | undefined
    if (e.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') lastAgent = item.text
    if ((e.type === 'error' || e.type === 'turn.failed') && !error) error = String((e as { message?: unknown }).message ?? (e.error as { message?: unknown } | undefined)?.message ?? 'error')
  }
  return { text: (result ?? lastAgent ?? '').trim(), ...(error ? { error } : {}) }
}

/** Replaced in tests. */
export const onceRunner = {
  run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise(res => {
      const p = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } })
      let out = ''
      let err = ''
      p.stdout.on('data', b => { out += b })
      p.stderr.on('data', b => { err = (err + b).slice(-4000) })
      const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs)
      p.on('close', code => { clearTimeout(timer); res({ code, out, err }) })
      p.on('error', e => { clearTimeout(timer); res({ code: null, out, err: String(e) }) })
    })
  },
}

export async function runOnce(d: Daemon, engine: EngineId, cwd: string, prompt: string, model?: string): Promise<OnceResult> {
  const start = Date.now()
  const cmd = onceArgv(engine, prompt, model)
  if (!cmd) return { ok: false, text: t('{engine} не установлен.', { engine: engineOf(engine).name }), ms: 0 }
  d.log(`once ${engine} in ${cwd}: ${prompt.length} chars`)
  const r = await onceRunner.run(cmd.bin, cmd.args, cwd, 10 * 60_000)
  const p = parseOnceOutput(r.out)
  const ms = Date.now() - start
  d.log(`once ${engine}: exit ${r.code}, ${p.text.length} chars in ${ms} ms${p.error ? `, error ${p.error}` : ''}`)
  if (!p.text) return { ok: false, text: p.error ?? (r.err.trim().split('\n').slice(-3).join('\n') || t('пустой ответ (код {code})', { code: String(r.code) })), ms }
  return { ok: r.code === 0 && !p.error, text: p.text, ms }
}

/** The other engine, when it is installed. */
export function otherEngine(e: EngineId): EngineId | null {
  const o: EngineId = e === 'claude' ? 'codex' : 'claude'
  return ENGINES[o].available() ? o : null
}

/** The review prompt: the task and the diff. Text for the model: not translated. */
export function reviewPrompt(task: string | null, diff: string, from: string): string {
  // i18n-ignore-start: for the model
  return [
    `Ты — ревьюер. Другая модель (${from}) сделала изменения в этой папке; они ниже как git diff. Файлы ничего не меняй.`,
    task ? `Задача, которую она выполняла:\n«${clip(task, 3000)}»` : 'Задача неизвестна — суди по diff.',
    'Проверь: делают ли изменения то, что просили; ошибки и крайние случаи; безопасность; что упущено (тесты, документация). Можно читать файлы проекта для контекста.',
    'Ответ — по-русски, Markdown: сначала вердикт одной строкой (✅ можно мержить / ⚠️ есть замечания / ❌ есть ошибки), затем замечания списком с file:line, по убыванию важности. Без воды.',
    '',
    '```diff',
    clip(diff, 60_000),
    '```',
  ].join('\n')
  // i18n-ignore-end
}

async function post(d: Daemon, c: ChatRef, head: string, r: OnceResult): Promise<void> {
  const secs = Math.round(r.ms / 1000)
  const md = `${head} · ${secs} ${t('с')}\n\n---\n\n${maskSecrets(clip(r.text, 30_000))}`
  const extra = c.threadId != null ? { message_thread_id: c.threadId } : {}
  try {
    await sendRich(d.bot, c.chatId, md, extra)
  } catch {
    await d.bot.api.sendMessage(c.chatId, clip(`${head}\n\n${maskSecrets(r.text)}`, 4000), extra).catch(err => d.log(`once post failed: ${err}`))
  }
}

/** «🔍 Ревью другой моделью» for a session: its diff and last task to the other engine, the verdict to the chat. */
export async function reviewSession(d: Daemon, s: Session, c: ChatRef): Promise<string | null> {
  const other = otherEngine(s.engine)
  if (!other) return t('Второй движок не установлен.')
  const diff = await gitDiff(s.cwd)
  if (diff == null) return t('Не удалось получить diff.')
  if (!diff.trim()) return t('Изменений нет: рабочее дерево чистое.')
  const task = [...turnsOf(s.engine, sessionTranscript(s))].reverse().find(x => x.role === 'user')?.text ?? null
  const extra = c.threadId != null ? { message_thread_id: c.threadId } : {}
  const note = await d.bot.api.sendMessage(c.chatId, t('🔍 {engine} смотрит изменения сессии #{id}…', { engine: engineOf(other).name, id: s.id }), extra).catch(() => null)
  void (async () => {
    const r = await runOnce(d, other, s.cwd, reviewPrompt(task, diff, engineOf(s.engine).name))
    if (note) await d.bot.api.deleteMessage(c.chatId, note.message_id).catch(() => {})
    await post(d, c, t('🔍 **Ревью {engine}** изменений #{id}', { engine: engineOf(other).name, id: s.id }) + (r.ok ? '' : ' · ⚠️'), r)
  })().catch(err => d.log(`review of ${s.id} failed: ${err}`))
  return null
}

function chatOf(ctx: Context): ChatRef {
  const m = ctx.callbackQuery?.message ?? ctx.message
  const threadId = m && 'is_topic_message' in m && m.is_topic_message ? m.message_thread_id : undefined
  return { chatId: String(ctx.chat!.id), threadId, isPrivate: ctx.chat!.type === 'private' }
}

/** The folder and session of a chat: a project topic's, else the main one. */
function placeOf(d: Daemon, c: ChatRef): { dir: string; session?: Session } {
  const dir = c.threadId != null ? d.store.topic(c.chatId, c.threadId)?.project_key ?? d.mainKey() : d.mainKey()
  return { dir, session: d.activeSessions().find(s => s.cwd === dir || s.projectKey === dir) }
}

export function registerOnceCommands(d: Daemon, bot: Bot): void {
  bot.command('once', async ctx => {
    if (!ctx.from || !can(ctx.from.id, 'control') || !ctx.chat) return
    const c = chatOf(ctx)
    const extra = c.threadId != null ? { message_thread_id: c.threadId } : {}
    let text = String(ctx.match ?? '').trim()
    const m = /^(claude|codex)\s+([\s\S]+)$/i.exec(text)
    const { dir } = placeOf(d, c)
    let engine: EngineId = projectEngine(d, dir).engine
    if (m) { engine = m[1].toLowerCase() as EngineId; text = m[2].trim() }
    if (!text) return void ctx.reply(t('Формат: /once [claude|codex] <вопрос> — один ход в папке топика без сессии, только чтение.'), extra)
    if (!ENGINES[engine].available()) return void ctx.reply(t('{engine} не установлен.', { engine: engineOf(engine).name }), extra)
    const note = await ctx.reply(t('⚡ Разовый ход {engine}…', { engine: engineOf(engine).name }), extra).catch(() => null)
    void (async () => {
      const model = projectEngine(d, dir).engine === engine ? projectEngine(d, dir).model : undefined
      const r = await runOnce(d, engine, dir, text, model)
      if (note) await d.bot.api.deleteMessage(c.chatId, note.message_id).catch(() => {})
      await post(d, c, t('⚡ **Разовый ход {engine}**', { engine: engineOf(engine).name }) + (r.ok ? '' : ' · ⚠️'), r)
    })().catch(err => d.log(`once failed: ${err}`))
  })

  bot.command('review', async ctx => {
    if (!ctx.from || !can(ctx.from.id, 'control') || !ctx.chat) return
    const c = chatOf(ctx)
    const extra = c.threadId != null ? { message_thread_id: c.threadId } : {}
    const { session } = placeOf(d, c)
    if (!session) return void ctx.reply(t('В этом чате нет подключённой сессии.'), extra)
    const err = await reviewSession(d, session, c)
    if (err) await ctx.reply(err, extra)
  })
}

/** rv:<session id> */
export async function handleReviewCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^rv:(\w+)$/.exec(data)
  if (!m) return false
  if (!ctx.from || !can(ctx.from.id, 'control') || !ctx.chat) {
    await ctx.answerCallbackQuery({ text: t('Нет доступа.') }).catch(() => {})
    return true
  }
  const s = d.sessions.get(m[1])
  if (!s) {
    await ctx.answerCallbackQuery({ text: t('Сессия уже отключилась.') }).catch(() => {})
    return true
  }
  const target = s.lastChat ?? chatOf(ctx)
  const err = await reviewSession(d, s, target)
  await ctx.answerCallbackQuery({ text: err ?? t('🔍 Запустил ревью') }).catch(() => {})
  return true
}

/** The button for a session card. */
export function reviewButton(s: Session): ReturnType<typeof button> | null {
  const other = otherEngine(s.engine)
  return other ? button(t('🔍 Ревью: {engine}', { engine: engineOf(other).name }), `rv:${s.id}`) : null
}

