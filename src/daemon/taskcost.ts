import { JsonTaskRepository, taskScopeKey } from './taskstore.ts'
import { ownsTask, Tasks, type Task } from '../core/task.ts'
export type { Task } from '../core/task.ts'
/** Durable task identity and accounting. Scope and transcript identity are explicit;
 * cwd/time windows are never used to attribute another conversation's requests. */
import { randomBytes } from 'crypto'
import { readFileSync, readdirSync } from 'fs'
import { dirname, basename, join } from 'path'
import { escapeHtml, fmtDuration } from '../format.ts'
import { t } from '../i18n/index.ts'
import { inChat } from './lang.ts'
import type { ChatRef, Daemon, Session } from './daemon.ts'
import { sessionTranscript, codexRollout } from './handoff.ts'
import { costOf, parseTranscript, taskMarkers, type Entry } from './usage.ts'
import { parseRollout } from './codexusage.ts'


export type Stage = { order: number; id: string; tasks: string[]; engine: string; session: string; conversation?: string; path?: string; start: number; end?: number; baseline: string[]; entries: Entry[]; tools: string[]; settled: boolean; auxiliary?: boolean; unallocatedRequests?: number }
const scope = taskScopeKey
const repository = (d: Daemon) => new JsonTaskRepository(d.store)
const tasks = (d: Daemon) => new Tasks(repository(d), () => randomBytes(8).toString('hex'), Date.now)
export const taskOf = (d: Daemon, id: string): Task | null => repository(d).get(id)
export function newTask(d: Daemon, c: ChatRef, user: string): Task { return tasks(d).create(c, user) }
export function changeTask(d: Daemon, id: string, state: Task['state']): void { tasks(d).change(id, state) }
/** Called before durable queues. Explicit new-task selection always starts a boundary. */
export function bindTask(d: Daemon, c: ChatRef, user: string, meta: Record<string, string>, fresh = false): string {
  const supplied = meta.task_id && taskOf(d, meta.task_id)
  if (meta.task_ids) {
    const ids = meta.task_ids.split(',').filter(id => { const task = taskOf(d, id); return task && ownsTask(task, c, user) })
    if (ids.length) { meta.task_ids = ids.join(','); return ids[0]! }
    delete meta.task_ids
  }
  const replyId = meta.reply_to_message_id
  const questionTask = meta.question_id ? d.store.get(`cost:question:${meta.question_id}`) : replyId ? d.store.get(`cost:message:${c.chatId}:${replyId}`) : null
  const parentQuestion = questionTask ? taskOf(d, questionTask) : null
  if (!fresh && parentQuestion && ownsTask(parentQuestion, c, user)) { meta.task_id = parentQuestion.id; changeTask(d, parentQuestion.id, 'open'); return parentQuestion.id }
  if (!fresh && !supplied && replyId) {
    const result = d.store.keys('ux:result:').map(k => JSON.parse(d.store.get(k)!)).find(r => r.taskId && r.chat.chatId === c.chatId && (r.chat.threadId ?? 0) === (c.threadId ?? 0) && [r.card, ...r.messages].includes(Number(replyId)))
    const parent = result && taskOf(d, result.taskId)
    if (parent?.user === user) { meta.task_id = parent.id; changeTask(d, parent.id, 'open'); return parent.id }
  }
  if (supplied && ownsTask(supplied, c, user)) return supplied.id
  let id = !fresh ? d.store.get(scope(c, user)) : null
  const task = id ? taskOf(d, id) : null
  if (!task || task.state === 'closed') id = newTask(d, c, user).id
  meta.task_id = id!; changeTask(d, id!, 'open')
  return id!
}
const stages = (d: Daemon): Stage[] => d.store.keys('cost:stage:').map(k => JSON.parse(d.store.get(k)!) as Stage)
function nextOrder(d: Daemon): number { const n = Number(d.store.get('cost:sequence') ?? 0) + 1; d.store.set('cost:sequence', String(n)); return n }
const save = (d: Daemon, r: Stage) => d.store.set(`cost:stage:${r.id}`, JSON.stringify(r))
export function activeStage(d: Daemon, s: Session): Stage | null {
  const id = d.store.get(`cost:active:${s.id}`)
  return id ? JSON.parse(d.store.get(`cost:stage:${id}`) ?? 'null') : null
}
/** Bind native agents through their actual parent tool call, not their log timestamps. */
function nativeAgentTasks(text: string): Map<string, string[]> {
  const calls = new Map<string, string[]>(), agents = new Map<string, string[]>()
  let current: string[] = []
  for (const line of text.split('\n')) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    const content = e.message?.content
    if (e.type === 'user' && typeof content === 'string') current = taskMarkers(content)
    if (!Array.isArray(content)) continue
    if (e.type === 'user' && !content.some(b => b.type === 'tool_result') && !e.isMeta) current = taskMarkers(content.filter(b => b.type === 'text').map(b => b.text).join('\n'))
    for (const block of content) {
      if (e.type === 'assistant' && block.type === 'tool_use' && ['Agent','Task'].includes(block.name)) calls.set(block.id, current)
      if (e.type === 'user' && block.type === 'tool_result') {
        const id = e.toolUseResult?.agentId ?? /agentId:\s*([\w-]+)/.exec(typeof block.content === 'string' ? block.content : '')?.[1]
        const task = calls.get(block.tool_use_id)
        if (typeof id === 'string' && task?.length) agents.set(id, task)
      }
    }
  }
  return agents
}
function entriesOf(r: Stage): Entry[] {
  if (!r.path) return []
  try {
    const text = readFileSync(r.path, 'utf8')
    if (r.engine === 'codex') return parseRollout(text, r.path, 0).entries
    const entries = parseTranscript(text, 0).map(e => ({ ...e, id: e.id.startsWith('line:') ? `${r.path}:${e.id}` : e.id }))
    // Claude stores native subagent requests under this exact conversation, never another cwd's logs.
    const dir = join(dirname(r.path), basename(r.path, '.jsonl'), 'subagents')
    const owners = nativeAgentTasks(text)
    try { for (const file of readdirSync(dir)) if (file.endsWith('.jsonl')) {
      const agent = basename(file, '.jsonl').replace(/^agent-/, '')
      entries.push(...parseTranscript(readFileSync(join(dir, file), 'utf8'), 0).map(e => ({ ...e, id: e.id.startsWith('line:') ? `${join(dir, file)}:${e.id}` : e.id, agent, tasks: owners.get(agent) ?? [] })))
    } } catch {}
    return entries
  } catch { return [] }
}
/** Snapshot exact transcript IDs before dispatch. Mixed tasks remain explicitly shared. */
export function startStage(d: Daemon, s: Session, meta: Record<string, string>): void {
  const ids = (meta.task_ids ?? meta.task_id ?? '').split(',').filter(id => !!taskOf(d, id))
  if (!ids.length) return
  let r = activeStage(d, s)
  if (r?.end) { reconcile(d, r); r = null }
  if (!r) {
    r = { order: nextOrder(d), id: randomBytes(8).toString('hex'), tasks: ids, engine: s.engine, session: s.id, conversation: s.claude.sessionId ?? undefined, path: sessionTranscript(s) ?? undefined, start: Date.now(), baseline: [], entries: [], tools: [], settled: false }
    for (const old of stages(d)) if (!old.end && !old.auxiliary && old.path && old.path === r.path) { old.end = Date.now(); reconcile(d, old) }
    r.baseline = entriesOf(r).map(e => e.id)
    d.store.set(`cost:active:${s.id}`, r.id)
  } else r.tasks = [...new Set([...r.tasks, ...ids])]
  save(d, r)
}
/** First hook of a new conversation establishes its identity, not a cwd search. */
export function stageHook(d: Daemon, s: Session, toolId?: string): void {
  let r = activeStage(d, s)
  if (!r) {
    r = stages(d).find(r => !r.end && !r.auxiliary && r.conversation && r.conversation === s.claude.sessionId) ?? null
    if (r) { r.session = s.id; d.store.set(`cost:active:${s.id}`, r.id) }
  }
  if (!r || r.end) return
  const path = sessionTranscript(s)
  if (r.conversation && s.claude.sessionId && r.conversation !== s.claude.sessionId && path && path !== r.path) {
    r.end = Date.now(); reconcile(d, r);
    d.store.set(`cost:active:${s.id}`, null)
    startStage(d, s, { task_ids: r.tasks.join(',') }); r = activeStage(d, s)!
  }
  if (!r.path) { r.path = sessionTranscript(s) ?? undefined; r.conversation = s.claude.sessionId ?? undefined }
  if (toolId && !r.tools.includes(toolId)) r.tools.push(toolId)
  save(d, r)
}
export function finishStage(d: Daemon, s: Session): void {
  stageHook(d, s)
  const r = activeStage(d, s)
  if (!r || r.end) return
  r.end = Date.now(); save(d, r)
  reconcile(d, r)
  // The next dispatch seals this stage before taking its own baseline.
  setTimeout(() => { const latest: Stage = JSON.parse(d.store.get(`cost:stage:${r.id}`)!); reconcile(d, latest); void refreshTaskCards(d, latest.tasks).catch(err => d.log(`task card: ${err}`)) }, 2200).unref?.()
}
export function reconcile(d: Daemon, r: Stage): void {
  if (r.auxiliary) return
  const excluded = new Set(r.baseline)
  // A later stage's baseline is the immutable upper boundary for this stage.
  const next = stages(d).filter(x => x.path && x.path === r.path && x.order > r.order).sort((a,b) => a.order-b.order)[0]
  const upper = next ? new Set(next.baseline) : null
  const available = entriesOf(r).filter(e => !excluded.has(e.id) && (e.agent || !upper || upper.has(e.id)))
  r.unallocatedRequests = available.filter(e => e.agent && !e.tasks?.length).length
  r.entries = available.filter(e => !e.tasks || e.tasks.some(id => r.tasks.includes(id)))
  r.settled = !!r.end && r.entries.length > 0
  save(d, r)
}
export function taskForSession(d: Daemon, s: Session): string | undefined {
  return activeStage(d, s)?.tasks[0]
}
export function taskReport(d: Daemon, id: string): string {
  const task = taskOf(d, id)
  if (!task) return ''
  const runs = stages(d).filter(r => r.tasks.includes(id))
  const entries = new Map<string, Entry>(); let tools = 0, ms = 0, pending = false, shared = false, unallocated = false
  const groups = new Map<string, { tokens: number; requests: number }>()
  for (const r of runs) {
    if (!r.auxiliary && !r.settled) reconcile(d, r)
    if (r.tasks.length > 1) { shared = true; continue }
    unallocated ||= !!r.unallocatedRequests
    pending ||= !r.settled; tools += r.tools.length; ms += Math.max(0, (r.end ?? Date.now())-r.start)
    for (const e of r.entries) {
      if (entries.has(e.id)) continue
      entries.set(e.id, e)
      const key = `${r.engine} / ${e.model}${r.auxiliary ? ' (review)' : ''}`
      const g = groups.get(key) ?? { tokens: 0, requests: 0 }; g.tokens += e.input + e.read + e.write5m + e.write1h + e.output; g.requests++; groups.set(key, g)
    }
  }
  let input = 0, cached = 0, output = 0, reasoning = 0, hasReasoning = false, price = 0, unpriced = false
  for (const e of entries.values()) { input += e.input + e.read + e.write5m + e.write1h; cached += e.read; output += e.output; if (e.reasoning !== undefined) { reasoning += e.reasoning; hasReasoning = true }; const cost = costOf(e); if (cost === null) unpriced = true; else price += cost }
  const status = task.state === 'closed' ? t('Задача закрыта') : task.state === 'ready' ? t('Результат готов; задача открыта') : t('Задача открыта')
  return `<blockquote expandable><b>${t('Расход задачи')}</b> · ${id}\n${status}\n${pending ? t('Расход уточняется') : t('Учтённые данные CLI')}\n${t('Вход / кэш / выход')}: ${input} / ${cached} / ${output}${hasReasoning ? `\n${t('Рассуждения (в составе выхода)')}: ${reasoning}` : ''}\n${t('Этапы / инструменты / время')}: ${runs.length} / ${tools} / ${fmtDuration(ms)}\n${[...groups].slice(0, 8).map(([k,g]) => `${escapeHtml(k.slice(0,100))}: ${g.requests} · ${g.tokens}`).join('\n')}${groups.size > 8 ? `\n${t('… ещё {n}', { n: groups.size - 8 })}` : ''}\n${t('Оценка API, не списание подписки')}: ${entries.size ? `$${price.toFixed(4)}` : '—'}${unpriced ? ` + ${t('есть модели без цены')}` : ''}${shared ? `\n${t('Совместный ход нескольких задач: расход не распределён')}` : ''}${unallocated ? `\n${t('Есть расходы субагентов без подтверждённой связи с задачей')}` : ''}\n${t('Кэш входит во вход; рассуждения входят в выход. Время этапов суммируется.')}</blockquote>`
}
export async function refreshTaskCards(d: Daemon, ids: string[]): Promise<void> {
  // Import lazily: result publication also calls task accounting.
  const { resultText, resultButtons, withResultLock } = await import('./ux.ts')
  for (const key of d.store.keys('ux:result:')) {
    const id = key.slice('ux:result:'.length)
    await withResultLock(d, id, async () => {
      const raw = d.store.get(key)
      if (!raw) return
      const r = JSON.parse(raw)
      if (!r.taskId || !ids.includes(r.taskId) || !r.card || r.dismissed) return
      await inChat(d, r.chat.chatId, r.chat.threadId, async () => {
        r.cost = taskReport(d, r.taskId); d.store.set(key, JSON.stringify(r))
        await d.bot.api.editMessageText(r.chat.chatId, r.card, resultText(r), { parse_mode: 'HTML', reply_markup: resultButtons(r) }).catch(err => d.log(`task cost card: ${err}`))
      })
    })
  }
}
/** Recovery retries incomplete transcripts, without invoking a model. */
export function recoverTaskCosts(d: Daemon): void {
  const refresh = () => {
    const ids = new Set<string>()
    for (const r of stages(d)) if (!r.auxiliary && r.end && (!r.settled || Date.now() - r.end < 300_000)) { const before = JSON.stringify(r.entries); const settled = r.settled; reconcile(d, r); if (before !== JSON.stringify(r.entries) || settled !== r.settled) for (const id of r.tasks) ids.add(id) }
    if (ids.size) void refreshTaskCards(d, [...ids]).catch(err => d.log(`task costs: ${err}`))
  }
  refresh(); setInterval(refresh, 30_000).unref?.()
}

/** A separately launched CLI is its own stage; retries get distinct IDs. */
export function startAuxiliary(d: Daemon, taskId: string, engine: string): string | undefined {
  if (!taskOf(d, taskId)) return
  const r: Stage = { order: nextOrder(d), id: randomBytes(8).toString('hex'), tasks: [taskId], engine, session: '', start: Date.now(), baseline: [], entries: [], tools: [], settled: false, auxiliary: true }
  save(d, r); return r.id
}
export function finishAuxiliary(d: Daemon, id: string, out: string, model?: string): void {
  const raw = d.store.get(`cost:stage:${id}`)
  if (!raw) return
  const r: Stage = JSON.parse(raw)
  r.entries = []; r.tools = []
  r.end = Date.now()
  // Claude stream records preserve per-message/model usage, including subagents.
  const lines = out.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  if (r.engine === 'claude') {
    r.entries = parseTranscript(lines.map(e => JSON.stringify({ ...e, timestamp: e.timestamp ?? new Date(r.end!).toISOString() })).join('\n'), 0)
    for (const e of lines) for (const block of e.message?.content ?? []) if (block.type === 'tool_use') r.tools.push(String(block.id))
    // A CLI may expose only its final aggregate rather than assistant usage.
    if (!r.entries.length) {
      const final = lines.findLast(e => e.type === 'result')
      if (final?.modelUsage) for (const [name, u] of Object.entries(final.modelUsage) as [string, Record<string, number>][]) r.entries.push({ id: `${id}:${name}`, ts: r.end, model: name, input: u.inputTokens ?? 0, read: u.cacheReadInputTokens ?? 0, output: u.outputTokens ?? 0, write5m: u.cacheCreationInputTokens ?? 0, write1h: 0, cwd: '' })
    }
  } else {
    for (const e of lines) {
      if (e.type === 'item.completed' && ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(e.item?.type)) r.tools.push(String(e.item?.id ?? r.tools.length))
      if (e.type !== 'turn.completed' || !e.usage) continue
      const u = e.usage
      r.entries.push({ id: `${id}:${r.entries.length}`, ts: r.end, model: model ?? 'codex', input: Math.max(0, (u.input_tokens ?? 0)-(u.cached_input_tokens ?? 0)), read: u.cached_input_tokens ?? 0, output: u.output_tokens ?? 0, ...(u.reasoning_output_tokens !== undefined ? { reasoning: u.reasoning_output_tokens } : {}), write5m: 0, write1h: 0, cwd: '' })
    }
  }
  if (r.engine === 'codex') {
    const thread = lines.find(e => e.type === 'thread.started' && typeof e.thread_id === 'string')?.thread_id
    const path = thread ? codexRollout(thread) : null
    if (path) { try { const actual = parseRollout(readFileSync(path, 'utf8'), path, 0).entries; if (actual.length) r.entries = actual } catch { /* stream usage remains authoritative if the rollout disappeared */ } }
  }
  r.settled = r.entries.length > 0; save(d, r)
  void refreshTaskCards(d, r.tasks).catch(err => d.log(`auxiliary costs: ${err}`))
}

/** Complete machine-readable report; no transcript text, server paths or other tasks' IDs. */
export function taskUsageData(d: Daemon, id: string): Record<string, unknown> {
  const task = taskOf(d, id)
  const seen = new Set<string>()
  const totals = { input: 0, cached: 0, cacheCreated: 0, output: 0, reasoning: 0, apiEstimateUSD: 0, unpricedRequests: 0, requests: 0, observedTools: 0, stageDurationMs: 0 }
  const detail = stages(d).filter(r => r.tasks.includes(id)).map(r => {
    if (!r.auxiliary) reconcile(d, r)
    const shared = r.tasks.length > 1
    if (!shared) { totals.observedTools += r.tools.length; totals.stageDurationMs += Math.max(0,(r.end ?? Date.now())-r.start) }
    const requests = r.entries.map(e => {
      const cost = costOf(e)
      const counted = !shared && !seen.has(e.id)
      if (counted) {
        seen.add(e.id); totals.requests++; totals.input += e.input + e.read + e.write5m + e.write1h; totals.cached += e.read; totals.cacheCreated += e.write5m + e.write1h; totals.output += e.output; totals.reasoning += e.reasoning ?? 0
        if (cost === null) totals.unpricedRequests++; else totals.apiEstimateUSD += cost
      }
      return { model: e.model, effort: e.effort, input: e.input + e.read + e.write5m + e.write1h, cached: e.read, cacheCreated5m: e.write5m, cacheCreated1h: e.write1h, output: e.output, reasoning: e.reasoning ?? null, apiEstimateUSD: cost, countedInTaskTotal: counted }
    })
    return { stage: r.id, engine: r.engine, auxiliary: !!r.auxiliary, startedAt: r.start, endedAt: r.end ?? null, usagePending: !r.settled, sharedUnallocated: shared, unallocatedNativeRequests: r.unallocatedRequests ?? 0, observedTools: r.tools.length, requests }
  })
  return { task: id, state: task?.state, createdAt: task?.at, elapsedMs: task ? Math.max(0, (task.state === 'open' ? Date.now() : task.updated)-task.at) : null, totals, stages: detail, notes: ['Cached and cache-created tokens are subsets of input; reasoning is a subset of output.', 'Reasoning null means unavailable, not zero. Shared stages are not allocated to individual tasks.', 'API estimates are not subscription charges; unpriced requests are excluded from the dollar subtotal.', 'Stage durations are summed, including parallel work. Tools count observed CLI/hook events only.'] }
}
