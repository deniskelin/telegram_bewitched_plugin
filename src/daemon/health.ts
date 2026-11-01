/**
 * FR-19: the resources every session shares. All sessions run on one tmux
 * server: if it dies (an OOM kill, a crash), they all stop at once and the
 * watchdog sends one «остановилась» per session with no cause. So the owner
 * gets one notice when the tmux server is replaced by another (a bare
 * disappearance is the normal exit of the last session) and when the OOM-kill
 * counter grows — cgroup v2 memory.events, or /proc/vmstat on kernels from
 * 4.13; on older ones only the tmux part works.
 */

import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import { t as tr } from '../i18n/index.ts'
import type { Daemon } from './daemon.ts'
import { sendNotice } from './journal.ts'

export type HealthReads = { tmuxPid: () => Promise<number | null>; oomKills: () => number | null }
export type HealthState = { tmuxPid: number | null; oomKills: number | null }

function tmuxPid(): Promise<number | null> {
  return new Promise(res => execFile('tmux', ['display-message', '-p', '#{pid}'], { timeout: 3000 }, (err, out) => res(err ? null : Number(String(out).trim()) || null)))
}

/** OOM kills so far: in this cgroup (v2), else system-wide; null when the kernel does not count them. */
function oomKills(): number | null {
  try {
    const v2 = /^0::(.*)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1]
    if (v2 != null) {
      const m = /^oom_kill (\d+)$/m.exec(readFileSync(`/sys/fs/cgroup${v2}/memory.events`, 'utf8'))
      if (m) return Number(m[1])
    }
  } catch {}
  try {
    const m = /^oom_kill (\d+)$/m.exec(readFileSync('/proc/vmstat', 'utf8'))
    if (m) return Number(m[1])
  } catch {}
  return null
}

export function startHealthWatch(d: Daemon, reads: HealthReads = { tmuxPid, oomKills }): void {
  const state: HealthState = { tmuxPid: null, oomKills: null }
  const tick = () => void checkHealth(d, state, reads).catch(err => d.log(`health check failed: ${err}`))
  tick()
  setInterval(tick, 30_000).unref?.()
}

export async function checkHealth(d: Daemon, state: HealthState, reads: HealthReads): Promise<void> {
  const pid = await reads.tmuxPid()
  if (state.tmuxPid != null && pid != null && pid !== state.tmuxPid) {
    d.log(`tmux server replaced: ${state.tmuxPid} → ${pid}`)
    await sendNotice(d, 'sessions', () => tr('🧨 tmux-сервер перезапустился (pid {from} → {to}): все сессии в нём остановились разом. Частая причина — нехватка памяти. Сессии запустятся снова по сообщениям или кнопками 🚀.', { from: state.tmuxPid!, to: pid }))
  }
  if (pid != null) state.tmuxPid = pid
  const oom = reads.oomKills()
  if (state.oomKills != null && oom != null && oom > state.oomKills) {
    d.log(`OOM kills: ${state.oomKills} → ${oom}`)
    await sendNotice(d, 'sessions', () => tr('🧨 Ядро убило процесс(ы) из-за нехватки памяти: {n} за последние 30 с. Если сессия остановилась без причины — дело в этом. Помогает меньше параллельных сессий и субагентов.', { n: oom - state.oomKills! }))
  }
  if (oom != null) state.oomKills = oom
}
