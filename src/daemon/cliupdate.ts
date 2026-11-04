/**
 * FR-20: update the agent CLIs from Telegram. /server → «⬆️ Обновить CLI»
 * shows the installed versions of Claude Code and Codex; a button runs
 * `claude update` / `codex update` and reports the version after. Running
 * sessions keep the old binary until they are restarted (♻️).
 */

import { InlineKeyboard, type Context } from 'grammy'
import { execFile } from 'child_process'
import { owner } from '../access.ts'
import { settings } from '../config.ts'
import { escapeHtml } from '../format.ts'
import { t } from '../i18n/index.ts'
import type { Daemon } from './daemon.ts'
import { codexBin } from './engines.ts'
import { show, type Screen } from './menu.ts'
import { button } from './stream.ts'

export type CliId = 'claude' | 'codex'

/** How the CLIs are called. Replaced in tests. */
export const cliRunner = {
  run(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
    return new Promise(res => execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CI: '1' } }, (err, stdout, stderr) =>
      res({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}`.trim() || String(err ?? '') })))
  },
}

function binOf(id: CliId): string | null {
  return id === 'claude' ? settings.claudeBin : codexBin()
}

const NAMES: Record<CliId, string> = { claude: 'Claude Code', codex: 'Codex' }

export async function cliVersion(id: CliId): Promise<string | null> {
  const bin = binOf(id)
  if (!bin) return null
  const r = await cliRunner.run(bin, ['--version'], 10_000)
  return r.ok ? (r.out.split('\n')[0] ?? '').trim() : null
}

/** Updates in progress: one per CLI. */
const running = new Set<CliId>()

export async function cliScreen(): Promise<Screen> {
  const [claude, codex] = await Promise.all([cliVersion('claude'), cliVersion('codex')])
  const lines = [t('⬆️ <b>Обновление CLI</b>'), '']
  lines.push(`🤖 Claude Code: ${claude ? `<code>${escapeHtml(claude)}</code>` : t('не найден')}`)
  lines.push(`🧩 Codex: ${codex ? `<code>${escapeHtml(codex)}</code>` : t('не найден')}`)
  lines.push('', t('<i>Запущенные сессии останутся на старой версии до перезапуска (♻️ в карточке сессии).</i>'))
  const row = []
  if (claude) row.push(button(running.has('claude') ? t('⏳ Claude Code…') : t('⬆️ Claude Code'), 'cli:up:claude', 'primary'))
  if (codex) row.push(button(running.has('codex') ? t('⏳ Codex…') : t('⬆️ Codex'), 'cli:up:codex'))
  return { text: lines.join('\n'), kb: new InlineKeyboard([...(row.length ? [row] : []), [button('🔄', 'cli:show'), button(t('« Сервер'), 'srv:refresh')]]) }
}

/** Run the update, report before → after and the tail of the output. */
export async function updateCli(d: Daemon, id: CliId): Promise<string> {
  const bin = binOf(id)
  if (!bin) return t('{name} не найден.', { name: NAMES[id] })
  if (running.has(id)) return t('{name}: обновление уже идёт.', { name: NAMES[id] })
  running.add(id)
  try {
    const before = await cliVersion(id)
    d.log(`cli update ${id}: ${bin} update (was ${before ?? '?'})`)
    const r = await cliRunner.run(bin, ['update'], 5 * 60_000)
    const after = await cliVersion(id)
    d.log(`cli update ${id}: ${r.ok ? 'ok' : 'failed'}, now ${after ?? '?'}`)
    const tail = r.out.split('\n').slice(-12).join('\n').slice(-1500)
    const head = !r.ok
      ? t('❌ {name}: обновление не удалось.', { name: NAMES[id] })
      : before === after
        ? t('✅ {name}: уже последняя версия ({v}).', { name: NAMES[id], v: escapeHtml(after ?? '?') })
        : t('✅ {name}: {before} → {after}. Новые сессии запустятся на ней; работающие — после ♻️.', { name: NAMES[id], before: escapeHtml(before ?? '?'), after: escapeHtml(after ?? '?') })
    return tail ? `${head}\n<pre>${escapeHtml(tail)}</pre>` : head
  } finally {
    running.delete(id)
  }
}

/** cli:show, cli:up:<claude|codex> — the owner only. */
export async function handleCliCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const m = /^cli:(show|up)(?::(claude|codex))?$/.exec(data)
  if (!m) return false
  if (String(ctx.from?.id) !== owner()) {
    await ctx.answerCallbackQuery({ text: t('Только для владельца.') }).catch(() => {})
    return true
  }
  if (m[1] === 'show' || !m[2]) {
    await ctx.answerCallbackQuery().catch(() => {})
    await show(ctx, await cliScreen())
    return true
  }
  const id = m[2] as CliId
  await ctx.answerCallbackQuery({ text: t('⬆️ Обновляю {name}…', { name: NAMES[id] }) }).catch(() => {})
  // The update takes a while: the screen shows ⏳ meanwhile, the result arrives as a new message.
  const msg = ctx.callbackQuery?.message
  void (async () => {
    const p = updateCli(d, id)
    await show(ctx, await cliScreen()).catch(() => {})
    const text = await p
    if (msg) await d.bot.api.sendMessage(msg.chat.id, text, { parse_mode: 'HTML', ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}) }).catch(err => d.log(`cli update notice failed: ${err}`))
    await show(ctx, await cliScreen()).catch(() => {})
  })().catch(err => d.log(`cli update failed: ${err}`))
  return true
}
