/**
 * /server in the owner's DM: the machine the bot and the Claude Code
 * sessions run on — CPU, load, memory, swap, disks, what eats them, and how
 * much the sessions and voice services take. All from /proc, no extra tools.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { execFile } from 'child_process'
import { readdirSync, readFileSync, statfsSync } from 'fs'
import { cpus, hostname, homedir } from 'os'
import { owner } from '../access.ts'
import { escapeHtml, fmtDuration } from '../format.ts'
import type { Daemon } from './daemon.ts'
import { show } from './menu.ts'
import { button } from './stream.ts'
import { bar } from './usage.ts'

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** utime+stime ticks of every process, from /proc/<pid>/stat. */
function procTicks(): Map<number, number> {
  const out = new Map<number, number>()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const st = read(`/proc/${name}/stat`)
    // Fields after the ")" that closes the command name: utime is the 12th, stime the 13th.
    const f = st.slice(st.lastIndexOf(')') + 2).split(' ')
    if (f.length > 12) out.set(Number(name), Number(f[11]) + Number(f[12]))
  }
  return out
}

/**
 * Busy share of all CPUs and of each process over `ms` — now, not averaged
 * over a process's life like ps shows.
 */
async function cpuSample(ms = 1000): Promise<{ busy: number; perProc: Map<number, number> }> {
  const sample = () => {
    const f = read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number)
    const idle = (f[3] ?? 0) + (f[4] ?? 0)
    return { idle, total: f.reduce((a, b) => a + b, 0) }
  }
  const a = sample()
  const pa = procTicks()
  await Bun.sleep(ms)
  const b = sample()
  const pb = procTicks()
  const total = b.total - a.total
  const perProc = new Map<number, number>()
  // Clock ticks are 1/100 s on Linux: ticks per second of one CPU = 100.
  for (const [pid, t] of pb) perProc.set(pid, ((t - (pa.get(pid) ?? t)) / (ms / 1000)))
  return { busy: total > 0 ? (1 - (b.idle - a.idle) / total) * 100 : 0, perProc }
}

function meminfo(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of read('/proc/meminfo').split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line)
    if (m) out[m[1]] = Number(m[2]) * 1024
  }
  return out
}

function gb(n: number): string {
  return n >= 1e12 ? `${(n / 1e12).toFixed(1)} ТБ` : n >= 1e9 ? `${(n / 1e9).toFixed(1)} ГБ` : `${Math.round(n / 1e6)} МБ`
}

type Proc = { pid: number; cpu: number; rss: number; comm: string; args: string }

function processes(): Promise<Proc[]> {
  return new Promise(res => execFile('ps', ['-eo', 'pid=,pcpu=,rss=,comm=,args=', '--sort=-pcpu'], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    if (err) return res([])
    res(String(out).split('\n').filter(Boolean).map(l => {
      const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)
      return m ? { pid: Number(m[1]), cpu: Number(m[2]), rss: Number(m[3]) * 1024, comm: m[4], args: m[5] } : null
    }).filter((p): p is Proc => p != null))
  }))
}

/** A short, safe name for a process line: no arguments (they can hold secrets). */
function procName(p: Proc): string {
  if (/stt_server\.py/.test(p.args)) return 'whisper (STT)'
  if (/silero_server\.py/.test(p.args)) return 'silero (TTS)'
  if (p.comm === 'bun' && /daemon\/main\.ts/.test(p.args)) return 'демон бота'
  return p.comm
}

export async function serverReport(d: Daemon): Promise<string> {
  const [{ busy, perProc }, all] = await Promise.all([cpuSample(), processes()])
  const procs = all.map(p => ({ ...p, cpu: perProc.get(p.pid) ?? 0 }))
  const cores = cpus().length
  const [l1, l5, l15] = read('/proc/loadavg').split(' ').map(Number)
  const up = Number(read('/proc/uptime').split(' ')[0]) * 1000
  const mem = meminfo()
  const memUsed = (mem.MemTotal ?? 0) - (mem.MemAvailable ?? 0)
  const swapUsed = (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0)
  const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0)

  const lines = [`🖥 <b>${escapeHtml(hostname())}</b> · аптайм ${fmtDuration(up)}`, '']
  lines.push(`⚙️ CPU: <b>${Math.round(busy)}%</b> ${bar(busy)}`)
  lines.push(`   ${escapeHtml(cpus()[0]?.model.replace(/\s+/g, ' ').trim() ?? '')} · ${cores} потоков`)
  lines.push(`   нагрузка ${l1.toFixed(2)} / ${l5.toFixed(2)} / ${l15.toFixed(2)} (1/5/15 мин) · ${Math.round(pct(l1, cores))}% от ядер`)
  lines.push(`🧠 Память: <b>${gb(memUsed)}</b> из ${gb(mem.MemTotal ?? 0)} ${bar(pct(memUsed, mem.MemTotal ?? 0))}`)
  lines.push(`   доступно ${gb(mem.MemAvailable ?? 0)} · кэш ${gb((mem.Cached ?? 0) + (mem.Buffers ?? 0))}`)
  if (mem.SwapTotal) lines.push(`💱 Swap: ${gb(swapUsed)} из ${gb(mem.SwapTotal)} ${bar(pct(swapUsed, mem.SwapTotal))}`)

  const seen = new Set<string>()
  for (const path of ['/', homedir()]) {
    try {
      const s = statfsSync(path)
      const total = s.blocks * s.bsize
      const free = s.bavail * s.bsize
      const key = `${s.blocks}:${s.bfree}`
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(`💾 Диск ${escapeHtml(path)}: <b>${gb(total - free)}</b> из ${gb(total)} ${bar(pct(total - free, total))}`)
    } catch {}
  }

  // Claude Code sessions and the bot's own pieces.
  const claude = procs.filter(p => p.comm === 'claude')
  const bot = procs.filter(p => /stt_server\.py|silero_server\.py/.test(p.args) || (p.comm === 'bun' && /daemon\/main\.ts/.test(p.args)))
  lines.push('', `🤖 Claude Code: ${claude.length} процесс(ов) · ${gb(claude.reduce((n, p) => n + p.rss, 0))} · CPU ${Math.round(claude.reduce((n, p) => n + p.cpu, 0))}%`)
  lines.push(`   сессий в боте: ${d.activeSessions().length}`)
  for (const p of bot) lines.push(`🧩 ${procName(p)}: ${gb(p.rss)} · CPU ${Math.round(p.cpu)}%`)

  const top = (by: 'cpu' | 'rss') => [...procs].sort((a, b) => b[by] - a[by]).slice(0, 5)
    .map(p => `• ${escapeHtml(procName(p))} (${p.pid}): ${by === 'cpu' ? `${Math.round(p.cpu)}% CPU` : gb(p.rss)}`)
  lines.push('', '🔥 <b>Больше всего CPU</b>', ...top('cpu'))
  lines.push('', '🐘 <b>Больше всего памяти</b>', ...top('rss'))
  lines.push('', `<i>CPU — за последнюю секунду (100% = одно ядро у процесса). ${new Date().toLocaleTimeString('ru-RU')}</i>`)
  return lines.join('\n')
}

const KB = () => new InlineKeyboard([[button('🔄 Обновить', 'srv:refresh')]])

export function registerServerCommands(d: Daemon, bot: Bot): void {
  bot.command('server', async ctx => {
    if (ctx.chat?.type !== 'private' || String(ctx.from?.id) !== owner()) return
    await ctx.reply(await serverReport(d), { parse_mode: 'HTML', reply_markup: KB() })
  })
}

export async function handleServerCallback(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  if (data !== 'srv:refresh') return false
  if (String(ctx.from?.id) !== owner()) {
    await ctx.answerCallbackQuery({ text: 'Только для владельца.' }).catch(() => {})
    return true
  }
  await ctx.answerCallbackQuery({ text: '🔄' }).catch(() => {})
  await show(ctx, { text: await serverReport(d), kb: KB() })
  return true
}
