import { viewScope } from './usageview.ts'
import { sessionView, saveSessionView, SESSION_FILTERS, type SessionView } from './sessionview.ts'
import { taskOf } from './taskcost.ts'
import { taskForSession } from './taskcost.ts'
/**
 * /sessions as a menu in one message, like BotFather: the list of sessions
 * with a button each; a button opens the session's card with its actions and
 * the progress settings of its chat; « Назад returns to the list.
 */

import { replacementSession, lastResult, deliveryPhase, type Delivery } from './ux.ts'
import { cancelTextBatch } from './economy.ts'
import { codexTakeHeld, codexHeldCount } from './engines.ts'
import { resolveTarget } from './inbound.ts'
import { pendingKeyOf } from './topics.ts'
import { InlineKeyboard, InputFile, type Context } from 'grammy'
import { can, NOTIFY_DONE_INFO, owner, prefsFor, setPref, verboseBadge } from '../access.ts'
import { join } from 'path'
import { settings } from '../config.ts'
import { clip, clipHtml, escapeHtml, fmtDuration } from '../format.ts'
import { locale, t, k } from '../i18n/index.ts'
import { isMessageNotModified, topicLink } from '../tg.ts'
import type { Daemon, Session } from './daemon.ts'
import { gitDiff, gitInfo } from './git.ts'
import { stopSession } from './inbound.ts'
import { passiveBlock, sessionCard, sessionChat, projectTitle, sessionLabel, sessionShortName, sortedSessions, statusLabel } from './report.ts'
import { button, urlButton } from './stream.ts'
import { archiveTopic, sessionTarget } from './topics.ts'
import { projectRules, removeProjectRule } from './permrules.ts'
import { listCodexConversations, listConversations, transcriptInfo, type Conversation } from './transcript.ts'
import { blockedScreen, questionAfterTyping } from './screen.ts'
import { launchUserSession, attachTarget, awaitConnect, closeWindow, continueOptions, endSession, endTiming, InputBlocked, launchOnce, screenKb, sessionName, waitGone } from './launch.ts'
import { ENGINES, effortLabel, engineOf, projectEffort, projectEngine, setProjectEffort, setProjectEngine } from './engines.ts'
import { agentLine, AGENT_EMOJI, menuStatus, menuStatusIcon, sessionEffort, sessionRc, sessionSections } from './report.ts'
import { reviewButton } from './oneshot.ts'
import { askSummary, buildHandoff, type Handoff } from './handoff.ts'

export const MAX_MESSAGE = 4000
export type Screen = { text: string; kb: InlineKeyboard }
export type Btn = ReturnType<typeof button> | ReturnType<typeof InlineKeyboard.url>

/** Keep status icons whole: slicing UTF-16 breaks variation selectors and ZWJ emoji. */
/**
 * /sessions: three sections — the owner's own (their DM session, ⏻ when it is
 * not running, and the main one), the users', the projects' — numbered
 * through, each line with the agent, model and effort; the buttons one after
 * another, in the same order.
 */
export async function sessionsList(d:Daemon,view:SessionView={filter:'all',page:0},scope:{chatId:string;threadId?:number}={chatId:owner()??''}):Promise<Screen>{
  const all=d.activeSessions(),o=owner(),own=o?d.userSession(o):undefined
  const rank=(s:Session)=>s.status==='waiting'?0:s.turn?.stuck||s.stopRequest?.phase==='failed'||d.store.get(`ux:error:${s.projectKey}`)?1:lastResult(d,s.projectKey)?.unread?2:s.status==='working'?3:4
  let others=all.filter(s=>s!==own)
  if(view.filter==='attention')others=others.filter(s=>rank(s)<3)
  if(view.filter==='working')others=others.filter(s=>s.status==='working')
  if(view.filter==='projects')others=others.filter(s=>!d.userIdOf(s))
  if(view.filter==='users')others=others.filter(s=>!!d.userIdOf(s))
  others.sort((a,b)=>rank(a)-rank(b)||sessionShortName(d,a).localeCompare(sessionShortName(d,b))||a.id.localeCompare(b.id))
  const passive=[...d.sessions.values()].filter(s=>s.passive)
  const pageSize=view.filter==='passive'?1:7
  const length=view.filter==='passive'?passive.length:others.length,pages=Math.max(1,Math.ceil(length/pageSize)),page=Math.min(view.page,pages-1)
  const lines=[t('📋 <b>Сессии</b> ({length})',{length:all.length}),t('Подключено: {connected} · работает: {working} · ждёт: {waiting} · не запущено: {offline}',{connected:all.length,working:all.filter(s=>s.status==='working').length,waiting:all.filter(s=>s.status==='waiting').length,offline:own?0:1})]
  const rows:Btn[][]=[]
  const shortName=(name:string)=>{const parts=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(name.replace(/\s+/g,' ').trim())].map(x=>x.segment);return parts.length>22?parts.slice(0,21).join('')+'…':parts.join('')}
  const add=(s:Session)=>{
    const taskId=taskForSession(d,s),task=taskId?taskOf(d,taskId):null
    const taskText=task&&task.chat.chatId===scope.chatId&&(task.chat.threadId??0)===(scope.threadId??0)?task.title:undefined
    const elapsed=fmtDuration(Date.now()-(s.turn?.start??s.lastActivity))
    lines.push(`${menuStatusIcon(s)} <b>${escapeHtml(clip(sessionShortName(d,s),70))}</b> · <tg-emoji emoji-id="${AGENT_EMOJI[s.engine]}">🤖</tg-emoji> ${s.engine==='codex'?'Codex':'Claude'} · ${elapsed}`)
    if(taskText&&s.turn)lines.push(`  ${t('Текущая задача')}: ${escapeHtml(clip(taskText,90))}`)
    if(d.store.get(`ux:error:${s.projectKey}`))lines.push(`  ${t('Не доставлено')}`)
    if(s.stopRequest?.phase==='failed')lines.push(`  ${t('Остановка не подтверждена')}`)
    if(s.turn?.stuck)lines.push(`  ${t('Не берёт сообщение')}`)
    if(lastResult(d,s.projectKey)?.unread)lines.push(`  ${t('Непрочитанный результат')}`)
    const short=shortName(sessionShortName(d,s))
    rows.push([{...button(short,`sm:s:${s.id}`),text:`${menuStatusIcon(s)} ${short}`,icon_custom_emoji_id:AGENT_EMOJI[s.engine]}])
  }
  lines.push(t('👤 <b>Владелец</b>'))
  if(own)add(own);else if(o){lines.push(`👤 <b>${escapeHtml(d.userShortName(o))}</b> · ⏻ ${t('не запущена')}`);rows.push([button(`⏻ ${shortName(d.userShortName(o))}`,'sm:owner')])}
  if(view.filter==='passive'){
    const subset=new Map(passive.slice(page*pageSize,page*pageSize+pageSize).map(s=>[s.id,s]))
    const adapter=new Proxy(d,{get:(target,key)=>key==='sessions'?subset:Reflect.get(target,key,target)})
    const block=await passiveBlock(adapter);if(block)lines.push(block)
  }else{
    if(others.some(s=>rank(s)<3))lines.push(`<b>${t('Требуют внимания')}</b>`)
    if(view.filter==='projects'||others.some(s=>!d.userIdOf(s)))lines.push(t('📂 <b>Проекты</b>'))
    for(const s of others.slice(page*7,page*7+7))add(s)
    if(passive.length){const subset=new Map(passive.slice(0,1).map(s=>[s.id,s]));const adapter=new Proxy(d,{get:(target,key)=>key==='sessions'?subset:Reflect.get(target,key,target)});const block=await passiveBlock(adapter);if(block)lines.push(clipHtml(block,600))}
  }
  const labels=[k('Все'),k('Требуют внимания'),k('Работают'),k('Проекты'),k('Пользователи'),k('без канала')]
  for(let i=0;i<SESSION_FILTERS.length;i+=3)rows.push(SESSION_FILTERS.slice(i,i+3).map((f,j)=>button(`${view.filter===f?'• ':''}${t(labels[i+j]!)}`,`sl:${f}`,view.filter===f?'primary':undefined)))
  if(pages>1)rows.push([...(page?[button('◀',`sl:page:${page-1}`)]:[]),button(`${page+1}/${pages}`,`sl:page:${page}`),...(page+1<pages?[button('▶',`sl:page:${page+1}`)]:[])])
  rows.push([...(d.permissions.size?[button(t('🔐 Разрешения ({size})',{size:d.permissions.size}),'sm:perms')]:[]),button(t('🔄 Обновить'),'sm:list'),button(t('👥 Пригласить'),'inv:start')])
  if(d.topicsChatId)rows.push([button(t('📂 Проекты'),'tm:list')])
  rows.push([button(t('« Меню'),'hub:main')])
  return{text:clipHtml(lines.join('\n'),MAX_MESSAGE),kb:new InlineKeyboard(rows as never)}
}

/** Sub-menus of a session card: c — 🤖 Агент (the engine: Claude Code or Codex), n — 🔔 notifications, m — ⚙️ management. */
export type CardGroup = 'c' | 'n' | 'm'

/**
 * A session's card: the card text and a short keyboard — stop, screen, the
 * three groups, Git, the topic — or, with group, that group's buttons and
 * « Назад to the card.
 */
export async function sessionScreen(d: Daemon, s: Session, group?: CardGroup): Promise<Screen> {
  const c = sessionChat(d, s)
  const p = prefsFor(c.chatId, c.threadId)
  const rows: Btn[][] = []
  const back = [button(t('« Назад'), `sm:s:${s.id}`)]
  const user = d.userIdOf(s)
  let text = await sessionCard(d, s)

  if (group === 'c') {
    if (s.tmuxPane) {
      rows.push([button('🧹 /compact', `sm:cmp:${s.id}`), button('🆕 /clear', `sm:clr:${s.id}`), button(t('🧠 Модель'), `sm:mdl:${s.id}`)])
      rows.push([button(t('🕘 Прошлые разговоры'), `sm:hist:${s.id}`), button(t('⚡ Быстрые команды'), `mc:list:${s.id}`)])
      // 📱 Remote Control is Claude Code's: on — a link to it (when known), off — /remote-control typed in.
      if (s.engine === 'claude') {
        const rc = await sessionRc(d, s)
        if (rc.url) rows.push([urlButton(t('📱 Открыть Remote Control'), rc.url)])
        else if (!rc.on) rows.push([button(t('📱 Включить Remote Control'), `sm:rc:${s.id}`)])
      }
    } else text += `\n\n<i>${t('Сессия не в tmux — команды не отправить.')}</i>`
    rows.push(back)
  } else if (group === 'n') {
    // The current value is marked; tapping it again does nothing harmful.
    rows.push(([0, 1, 2] as const).map(v => button(`${p.verbose === v ? '• ' : ''}${verboseBadge(v)}`, `sm:v:${s.id}:${v}`, p.verbose === v ? 'primary' : undefined)))
    rows.push((['off', 'long', 'always'] as const).map(v => button(`${p.notifyDone === v ? '• ' : ''}✅ ${v === 'long' ? t('долгие') : t(NOTIFY_DONE_INFO[v])}`, `sm:n:${s.id}:${v}`, p.notifyDone === v ? 'primary' : undefined)))
    rows.push(back)
    const where = c.threadId != null ? t('в топике') : s.group ? t('в группе') : user ? t('в личке пользователя') : t('в личке')
    text += `\n\n<i>${t('Подробность прогресса и «✅ готово» {where}:', { where })}</i>`
  } else if (group === 'm') {
    const actions: Btn[] = []
    if (s.topic) actions.push(button(t('🗄 В архив'), `sm:ar:${s.id}`))
    if (s.tmuxPane) actions.push(button(t('♻️ Перезапустить'), `wd:rs:${s.id}`))
    if (actions.length) rows.push(actions)
    if (s.group) rows.push([button(t('👥 Отвязать группу'), `gp:unbind:${s.group.chatId}`, 'danger')])
    if (user && user !== owner()) rows.push([button(t('🚫 Удалить пользователя'), `ur:ask:${user}`, 'danger')])
    const perms: Btn[] = []
    if (s.alwaysAllow.size) perms.push(button(t('♾ Снова спрашивать'), `sm:aar:${s.id}`))
    if (projectRules(d, s.projectKey).length) perms.push(button(t('📌 Правила проекта'), `sm:prm:${s.id}`))
    if (perms.length) rows.push(perms)
    if (rows.length === 0) text += `\n\n<i>${t('Для этой сессии здесь ничего нет.')}</i>`
    rows.push(back)
  } else {
    const top: Btn[] = []
    if (s.tmuxPane && s.status === 'working') top.push(button(t('⏹ Стоп'), `sm:stop:${s.id}`, 'danger'))
    if (s.tmuxPane && /^%\d+$/.test(s.tmuxPane)) top.push(button(t('👁 Экран и клавиши'), `tx:p${s.tmuxPane.slice(1)}`))
    if (top.length) rows.push(top)
    rows.push([button(t('Отменить очередь'), `sm:qclear:${s.id}`)])
    const result = lastResult(d, s.projectKey)
    if (result && result.chat.chatId === owner()) rows.push([button(t('Последний результат'), `urx:show:${result.id}`)])
    else if (result?.chat.chatId.startsWith('-')) {
      const url = topicLink(result.chat.chatId, result.card ?? result.messages[0]!)
      if (url) rows.push([InlineKeyboard.url(t('Последний результат'), url)])
    }
    rows.push([button(t('🤖 Агент'), `sm:g:${s.id}:c`), button(t('🔔 Уведомления'), `sm:g:${s.id}:n`)])
    const review = s.branch ? reviewButton(s) : null
    rows.push([...(s.branch ? [button('🌿 Git', `sm:git:${s.id}`)] : []), ...(review ? [review] : []), button(t('⚙️ Управление'), `sm:g:${s.id}:m`)])
    const link = s.topic ? topicLink(s.topic.chatId, s.topic.threadId) : null
    if (link) rows.push([InlineKeyboard.url(clip(t('💬 Открыть топик «{name}»', { name: s.topic!.name }), 40), link)])
    rows.push([button(t('« К списку'), 'sm:list'), button('🔄', `sm:s:${s.id}`)])
  }
  return { text, kb: new InlineKeyboard(rows as never) }
}

/**
 * /clear, /compact, /model, /cost typed in a session's chat: the daemon
 * answers with a confirmation (or the picker, or the card) instead of passing
 * the text to the model — a turn spent on nothing (FR-9). The buttons are the
 * card's own: confirmed, the command is typed into the session's window.
 */
export async function sessionCommandScreen(d: Daemon, s: Session, cmd: 'clear' | 'compact' | 'model' | 'cost'): Promise<Screen> {
  if (cmd === 'cost') return sessionScreen(d, s)
  if (!s.tmuxPane) return { text: t('Сессия не в tmux — команды не отправить.'), kb: new InlineKeyboard() }
  if (cmd === 'clear') return (await controlAction(d, s, 'clr', undefined)).screen!
  if (cmd === 'model') return (await controlAction(d, s, 'mdl', undefined)).screen!
  const kb = new InlineKeyboard([[button(t('✅ Да, /compact'), `sm:cmp:${s.id}`, 'primary'), button(t('Отмена'), `sm:g:${s.id}:c`)]])
  return { text: t('Сжать разговор сессии #{id} ({v})? {engine} перескажет его коротко, место в контексте освободится.', { id: s.id, v: escapeHtml(projectTitle(s)), engine: engineOf(s.engine).name }), kb }
}

/**
 * 🚀 per installed agent — «🚀 Claude Code», «🚀 Codex» — the folder's own one
 * first and marked; one 🚀 when only one is installed.
 */
export function launchEngineKb(d: Daemon, dir: string, data: (engine: string) => string, tail: Btn[][] = []): InlineKeyboard {
  const cur = projectEngine(d, dir).engine
  const engines = Object.values(ENGINES).filter(e => e.available()).sort((a, b) => Number(b.id === cur) - Number(a.id === cur))
  const rows = engines.length > 1
    ? [engines.map(e => button(t('🚀 {engine}', { engine: e.name }), data(e.id), e.id === cur ? 'primary' : undefined))]
    : [[button(t('🚀 Запустить'), data(cur))]]
  return new InlineKeyboard([...rows, ...tail] as never)
}

/**
 * 🧠: the session's engine, its models and the reasoning effort; the chosen
 * model and effort go in now (/model, /effort) where the engine can, and stay
 * the project's (FR-15).
 */
export async function modelScreen(d: Daemon, s: Session): Promise<Screen> {
  const choice = projectEngine(d, s.projectKey)
  const engine = engineOf(choice.engine)
  const cur = choice.model
  const switching = engine.id !== s.engine
  const rows: Btn[][] = []
  // The switch first: once another engine is chosen, that is what the owner came for.
  if (switching) rows.push([button(t('♻️ Переключить на {engine} сейчас', { engine: engine.name }), `sm:engre:${s.id}`, 'primary')])
  // FR-16: the engine row once a second CLI is installed.
  const engines = Object.values(ENGINES).filter(e => e.available())
  if (engines.length > 1) rows.push(engines.map(e => button(`${e.id === engine.id ? '• ' : ''}${e.name}`, `sm:eng:${s.id}:${e.id}`)))
  rows.push(...engine.models.map(m => [button(`${cur === m.id ? '• ' : ''}🧠 ${m.id.replace(/^claude-/, '')}`, `sm:model:${s.id}:${m.alias}`, cur === m.id ? 'primary' : undefined)]))
  if (cur) rows.push([button(t('↩️ Модель по умолчанию CLI'), `sm:mdldef:${s.id}`)])
  // The effort: the levels of the project's engine; the project's choice is marked.
  const effort = projectEffort(d, s.projectKey, engine.id)
  const running = engine.id === s.engine ? await sessionEffort(s) : null
  if (engine.efforts.length) {
    // The dot: the project's choice, or — with the CLI default — the level the session runs at.
    const marked = effort ?? running
    const btns = engine.efforts.map(e => button(`${marked === e ? '• ' : ''}${effortLabel(e)}`, `sm:eff:${s.id}:${e}`, marked === e ? 'primary' : undefined))
    // Five levels do not fit one row on a phone: 3 + 2.
    rows.push(btns.slice(0, 3), ...(btns.length > 3 ? [btns.slice(3)] : []))
    if (effort) rows.push([button(t('↩️ Уровень по умолчанию CLI'), `sm:effdef:${s.id}`)])
  }
  rows.push([button(t('« Назад'), `sm:g:${s.id}:c`)])
  const text = [
    t('🧠 <b>Движок и модель</b> · сессия #{id} ({v})', { id: s.id, v: escapeHtml(projectTitle(s)) }),
    t('Настройки агента применяются к проекту, а не только к этому чату.'),
    ...(engine.liveEffortSwitch ? [t('Глубина размышлений меняется между ходами.')] : []),
    engine.liveModelSwitch ? t('Модель меняется между ходами; смена движка требует перезапуска.') : t('Модель и глубина размышлений применятся после перезапуска.'),
    t('Сейчас работает: <b>{engine}</b>', { engine: engineOf(s.engine).name }),
    t('Для проекта: <b>{engine}</b> · модель <b>{model}</b>', { engine: engine.name, model: cur ? escapeHtml(cur) : t('по умолчанию CLI') }),
    ...(engine.efforts.length ? [t('🎚 Уровень рассуждений: <b>{effort}</b>{now}', {
      effort: effort ? escapeHtml(effortLabel(effort)) : t('по умолчанию CLI'),
      now: running && running !== effort ? t(' (сейчас: {v})', { v: escapeHtml(effortLabel(running)) }) : '',
    })] : []),
    '',
    switching
      ? t('<i>«♻️ Переключить» закроет сессию и сразу запустит её на {engine} с передачей дел: {running} оставит последние реплики и состояние git в .telegram/handoff.md, {engine} продолжит с них. Подтверждать в терминале ничего не нужно.</i>', { running: engineOf(s.engine).name, engine: engine.name })
      : engine.liveModelSwitch
        ? t('<i>Модель меняется сразу командой <code>/model</code>, без перезапуска, и запоминается для проекта.</i>')
        : t('<i>{engine} меняет модель только перезапуском: после выбора предложу перезапустить с тем же разговором.</i>', { engine: engine.name }),
  ].join('\n')
  return { text, kb: new InlineKeyboard(rows as never) }
}

/**
 * ♻️ A session started again on the project's engine and model: closed with
 * the /exit checks, its window closed, started with the conversation it
 * should continue (the same one on the same engine; on a switch — the last
 * one that engine had in the folder), the startup prompt answered — the
 * owner asked for it with the button. Every step edits the menu message.
 */
export async function switchSession(d: Daemon, s: Session, edit: (sc: Screen) => Promise<void>, o: { note?: string; after?: (n: Session) => Promise<void>; resume?: string } = {}): Promise<Session | null> {
  const taskId = taskForSession(d, s)
  const choice = projectEngine(d, s.projectKey)
  const engine = engineOf(choice.engine)
  const same = engine.id === s.engine
  const back = new InlineKeyboard([[button(t('« Сессии'), 'sm:list')]])
  const chat = s.lastChat ?? sessionTarget(d, s)
  d.log(`switch session ${s.id}: ${s.engine} → ${engine.id}${choice.model ? `/${choice.model}` : ''} (${s.cwd})`)
  // Another engine: the work is handed over (handoff.ts) — gathered while the outgoing conversation is still known.
  let handoff: Handoff | null = null
  if (!same) {
    // FR-16: the outgoing model writes a summary first — unless it is out of tokens (o.note: FR-18) or switched off.
    let summary: string | null = null
    if (!o.note && settings.handoffSummarySec > 0 && !s.turn && chat) {
      await edit({ text: t('📝 {engine} пишет сводку для передачи дел (до {n} с)…', { engine: engineOf(s.engine).name, n: settings.handoffSummarySec }), kb: new InlineKeyboard() })
      const meta = { event: 'handoff_summary', task_id: taskForSession(d, s) ?? '', chat_id: chat.chatId, ...(chat.threadId != null ? { thread_id: String(chat.threadId) } : {}) }
      s.quietTurn = true
      summary = await askSummary(s, engine.id, text => d.deliver(s, text, meta), () => d.sessions.has(s.id), settings.handoffSummarySec * 1000)
        .catch(err => { d.log(`handoff summary of ${s.id} failed: ${err}`); return null })
      d.log(`handoff summary of ${s.id}: ${summary ? `${summary.length} chars` : 'none'}`)
    }
    handoff = await buildHandoff(s, engine.id, o.note, summary).catch(err => { d.log(`handoff of ${s.id} failed: ${err}`); return null })
    if (handoff) d.log(`handoff of ${s.id}: ${handoff.path}`)
  }
  await edit({ text: t('♻️ Закрываю сессию #{id} ({engine})…', { id: s.id, engine: engineOf(s.engine).name }), kb: new InlineKeyboard() })
  const pane = s.tmuxPane
  if (!endSession(d, s)) { await edit({ text: t('Сессия не в tmux — перезапустите её сами.'), kb: back }); return null }
  if (!(await waitGone(d, s.id, endTiming.checkMs * 2 + 10_000))) {
    d.ending.delete(s.id)
    await edit({ text: t('❌ Сессия #{id} не закрылась ни по /exit, ни по Ctrl-C, ни по SIGTERM. Посмотрите окно в tmux.', { id: s.id }), kb: back })
    return null
  }
  await closeWindow(d, pane)
  // Another engine starts a fresh conversation with the handoff: its own old thread would be stale next to it.
  const conv = same && o.resume ? { resume: o.resume } : same && s.claude.sessionId ? { resume: s.claude.sessionId } : handoff ? {} : continueOptions(d, s.cwd, engine.id)
  const l = await launchOnce(d, s.cwd, { name: sessionName(d, s.projectKey, engine.id), ...conv }, false)
  if (!l.ok) { await edit({ text: l.skipped ? t('⏳ Сессия уже запускается.') : t('❌ Не удалось запустить: {v}', { v: escapeHtml(l.error) }), kb: back }); return null }
  const where = escapeHtml(attachTarget(l.window))
  await edit({ text: t('🚀 Запускаю {engine} в tmux: окно {v}. Жду подключения…', { engine: engine.name, v: where }), kb: new InlineKeyboard() })
  const r = await awaitConnect(d, s.cwd, l.window, { confirm: true })
  if (!r.ok) {
    const why = r.reason === 'gone' ? t('окно закрылось') : r.reason === 'stuck' ? t('на экране вопрос, на который я не отвечаю сам') : t('не подключилась за {n} с', { n: Math.round(r.ms / 1000) })
    await edit({ text: t('⚠️ {engine} в окне {v} не подключился: {why}. Посмотрите экран.', { engine: engine.name, v: where, why }), kb: screenKb(l.window) })
    return null
  }
  // The new engine gets the handoff first: what was going on, where the full context is.
  if (handoff && chat) d.deliver(r.session, handoff.message, { event: 'handoff', task_id: taskId ?? '', chat_id: chat.chatId, ...(chat.threadId != null ? { thread_id: String(chat.threadId) } : {}) }, chat)
  const kept = handoff ? t('дела переданы: последние реплики и состояние git') : conv.resume || conv.continue ? t('разговор продолжается') : t('новый разговор')
  await edit({
    text: t('✅ Сессия #{id} работает на <b>{engine}</b>{model}: {kept}. Окно {v}. Можно писать.', { id: r.session.id, engine: engine.name, model: choice.model ? ` · ${escapeHtml(choice.model)}` : '', kept, v: where }),
    kb: new InlineKeyboard([[button(t('« К сессии'), `sm:s:${r.session.id}`), button(t('« Сессии'), 'sm:list')]]),
  })
  if (o.after) await o.after(r.session).catch(err => d.log(`after switch of ${s.id} failed: ${err}`))
  return r.session
}

/**
 * /compact, /clear (asked first) and /model typed into the session's pane.
 * Only between turns: typed mid-turn they would land in the prompt queue.
 */
export async function controlAction(d: Daemon, s: Session, action: string, value: string | undefined): Promise<{ toast?: string; screen?: Screen; sent?: boolean }> {
  if (!s.tmuxPane) return { toast: t('Сессия не в tmux — команды не отправить.') }
  if (action === 'rc' && s.engine !== 'claude') return { toast: t('Remote Control есть только у Claude Code.') }
  if (action === 'mdl') return { screen: await modelScreen(d, s) }
  if (action === 'eng') {
    const engine = ENGINES[value as keyof typeof ENGINES]
    if (!engine?.available()) return { toast: t('Этот движок не установлен.') }
    if (engine.id !== projectEngine(d, s.projectKey).engine) {
      setProjectEngine(d, s.projectKey, { engine: engine.id })
      d.log(`project ${s.projectKey}: engine → ${engine.id} (session ${s.id} runs ${s.engine})`)
    }
    return { toast: t('🧠 Проект → {engine}', { engine: engine.name }), screen: await modelScreen(d, s) }
  }
  if (action === 'effdef') {
    const engine = projectEngine(d, s.projectKey).engine
    setProjectEffort(d, s.projectKey, engine, null)
    return { toast: t('↩️ Следующие запуски — на уровне по умолчанию CLI'), screen: await modelScreen(d, s) }
  }
  if (action === 'eff') {
    const engine = engineOf(projectEngine(d, s.projectKey).engine)
    if (!value || !engine.efforts.includes(value)) return { toast: t('Неизвестный уровень.') }
    setProjectEffort(d, s.projectKey, engine.id, value)
    d.log(`project ${s.projectKey}: effort → ${value} (${engine.id})`)
    // Another engine than the running one: from its next launch.
    if (engine.id !== s.engine) return { toast: t('🎚 {v} — со следующего запуска', { v: effortLabel(value) }), screen: await modelScreen(d, s) }
    if (!engine.liveEffortSwitch) {
      const kb = new InlineKeyboard([
        [button(t('♻️ Перезапустить сейчас'), `sm:engre:${s.id}`, 'primary')],
        [button(t('Позже — со следующего запуска'), `sm:mdl:${s.id}`)],
      ])
      return { toast: `🎚 ${effortLabel(value)}`, screen: { text: t('🎚 {engine} меняет уровень рассуждений только перезапуском. Перезапустить сессию #{id} на уровне <b>{v}</b>? Разговор продолжится.', { engine: engine.name, id: s.id, v: escapeHtml(effortLabel(value)) }), kb } }
    }
  }
  if (action === 'mdldef') {
    setProjectEngine(d, s.projectKey, { engine: projectEngine(d, s.projectKey).engine })
    return { toast: t('↩️ Следующие запуски — на модели по умолчанию CLI'), screen: await modelScreen(d, s) }
  }
  if (action === 'clr') {
    const kb = new InlineKeyboard([[button(s.engine === 'codex' ? t('✅ Да, /new') : t('✅ Да, /clear'), `sm:clrok:${s.id}`, 'danger'), button(t('Отмена'), `sm:g:${s.id}:c`)]])
    return { screen: { text: t('Очистить разговор сессии #{id} ({v})? Контекст начнётся заново, транскрипт останется для <code>--resume</code>.', { id: s.id, v: escapeHtml(projectTitle(s)) }), kb } }
  }
  if (s.turn || s.status !== 'idle') return { toast: t('Сессия работает — дождитесь конца хода или нажмите ⏹.') }
  const project = projectEngine(d, s.projectKey)
  const model = action === 'model' ? engineOf(project.engine).models.find(m => m.alias === value)?.id ?? '' : ''
  // A model of another engine, or an engine without /model <id>: it applies from the next launch.
  if (model && (project.engine !== s.engine || !engineOf(s.engine).liveModelSwitch)) {
    setProjectEngine(d, s.projectKey, { engine: project.engine, model })
    d.log(`project ${s.projectKey}: model → ${model} (${project.engine})`)
    if (project.engine !== s.engine) return { toast: t('🧠 {model} — со следующего запуска', { model }), screen: await modelScreen(d, s) }
    // The same engine without /model <id> (Codex): the model needs a restart — offered right away, with the conversation.
    const kb = new InlineKeyboard([
      [button(t('♻️ Перезапустить сейчас'), `sm:engre:${s.id}`, 'primary')],
      [button(t('Позже — со следующего запуска'), `sm:mdl:${s.id}`)],
    ])
    return { toast: `🧠 ${model}`, screen: { text: t('🧠 {engine} меняет модель только перезапуском. Перезапустить сессию #{id} на <b>{model}</b>? Разговор продолжится.', { engine: engineOf(s.engine).name, id: s.id, model: escapeHtml(model) }), kb } }
  }
  // Codex names a fresh conversation /new; /compact is the same in both.
  const line = action === 'rc' ? '/remote-control' : action === 'cmp' ? '/compact' : action === 'clrok' ? (s.engine === 'codex' ? '/new' : '/clear') : action === 'resume' ? `/resume ${value}` : action === 'eff' ? `/effort ${value}` : `/model ${model}`
  if (line === '/model ') return { toast: t('Неизвестная модель.') }
  try {
    await d.tmuxType(s.tmuxPane, line)
  } catch (err) {
    if (!(err instanceof InputBlocked)) throw err
    const screen = await blockedScreen(d, s.tmuxPane)
    return { toast: t('⛔ {line} не набрана: сессия ждёт ответа на экране', { line }), ...(screen ? { screen } : {}) }
  }
  if (action === 'clrok') s.contextWarned = false
  if (model) setProjectEngine(d, s.projectKey, { engine: project.engine, model })
  const question = await questionAfterTyping(d, s.tmuxPane)
  return { toast: `➡️ ${line}`, sent: true, ...(question ? { screen: question } : {}) }
}

const dashless = (id: string) => id.replace(/-/g, '')

function when(ms: number): string {
  return new Date(ms).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** The folder's conversations of the session's engine: Claude's transcripts or Codex's rollouts. */
function conversationsOf(s: Session, limit = 8): Promise<Conversation[]> {
  return s.engine === 'codex' ? listCodexConversations(s.cwd, limit) : listConversations(s.cwd, limit)
}

/** 🕘 The project's conversations, newest first; the current one is marked. */
async function historyScreen(s: Session): Promise<Screen> {
  const list = await conversationsOf(s)
  const how = s.engine === 'codex'
    ? t('Выбранный продолжится перезапуском сессии с ним (Codex не переключает разговор на ходу).')
    : t('Выбранный продолжится в этой же сессии командой <code>/resume</code> — без перезапуска.')
  const lines = [t('🕘 <b>Разговоры</b> · {v}', { v: escapeHtml(projectTitle(s)) }), how, '']
  const rows: Btn[][] = []
  for (const c of list) {
    const current = c.id === s.claude.sessionId
    const prompt = c.prompt ? clip(c.prompt, 70) : t('(без текста)')
    lines.push(`${current ? '▶️' : '•'} ${when(c.mtime)} · ${t('{n} КБ', { n: Math.max(1, Math.round(c.size / 1024)) })}${current ? t(' · <b>сейчас</b>') : ''}\n   ${escapeHtml(prompt)}`)
    if (!current) rows.push([button(clip(`${when(c.mtime)} ${c.prompt || '…'}`, 40), `sm:rs:${s.id}:${dashless(c.id)}`)])
  }
  if (!list.length) lines.push(t('Транскриптов этой папки нет.'))
  rows.push([button(t('« Назад'), `sm:g:${s.id}:c`)])
  return { text: lines.join('\n'), kb: new InlineKeyboard(rows as never) }
}

/** 📌 Tools allowed for the project for good, each with a button to ask again. */
function rulesScreen(d: Daemon, s: Session): Screen {
  const rules = projectRules(d, s.projectKey)
  const lines = [t('📌 <b>Без вопросов в проекте</b> {v}', { v: escapeHtml(projectTitle(s)) }), rules.length ? t('Эти инструменты разрешаются сами в любой сессии проекта, и после перезапуска тоже. ❌ — снова спрашивать.') : t('Правил нет.')]
  const rows: Btn[][] = rules.slice(0, 20).map((t, i) => [button(clip(`❌ ${t}`, 40), `sm:prmd:${s.id}:${i}`)])
  rows.push([button(t('« Назад'), `sm:g:${s.id}:m`)])
  return { text: lines.join('\n'), kb: new InlineKeyboard(rows as never) }
}

async function gitScreen(s: Session): Promise<Screen> {
  const back = [button(t('« Назад'), `sm:s:${s.id}`), button('🔄', `sm:git:${s.id}`)]
  const g = await gitInfo(s.cwd)
  if (!g) return { text: t('🌿 <code>{v}</code> — не git-репозиторий.', { v: escapeHtml(s.cwd) }), kb: new InlineKeyboard([back]) }
  const parts = [`🌿 <b>Git</b> · ${escapeHtml(projectTitle(s))}`, `<pre>${escapeHtml(g.status)}</pre>`]
  if (g.log) parts.push(t('Последние коммиты:\n<pre>{v}</pre>', { v: escapeHtml(g.log) }))
  if (g.pr) parts.push(`🔀 PR <a href="${escapeHtml(g.pr.url)}">#${g.pr.number}</a> · ${escapeHtml(g.pr.state.toLowerCase())} · ${escapeHtml(g.pr.title)}`)
  let text = parts.join('\n')
  text = clipHtml(text, MAX_MESSAGE)
  const rows: Btn[][] = [[button(t('📄 diff файлом'), `sm:gdf:${s.id}`)]]
  if (g.pr) rows[0].push(InlineKeyboard.url(`🔀 PR #${g.pr.number}`, g.pr.url))
  rows.push(back)
  return { text, kb: new InlineKeyboard(rows as never) }
}

export async function show(ctx: Context, sc: Screen): Promise<void> {
  await ctx.editMessageText(sc.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: sc.kb })
    .catch(err => { if (!isMessageNotModified(err)) throw err })
}

/** sm:list, sm:s:<id>, sm:g:<id>:<c|n|m>, sm:stop|main|ar|arok|rc|cmp|cmpn|clr|clrok|mdl|hist|prm:<id>, sm:rs|rsok:<id>:<conversation id without dashes>, sm:prmd:<id>:<n>, sm:model:<id>:<alias>, sm:mdldef:<id>, sm:eff:<id>:<level>, sm:effdef:<id>, sm:eng:<id>:<engine>, sm:engre:<id>, sm:v:<id>:<0-2>, sm:n:<id>:<off|long|always> */
export async function handleSessionMenu(d: Daemon, ctx: Context, data: string): Promise<boolean> {
  const list=/^sl:(all|attention|working|projects|users|passive|page)(?::(\d{1,6}))?$/.exec(data)
  if(list){
    if(!ctx.from||!can(ctx.from.id,'control')){await ctx.answerCallbackQuery({text:t('Нет доступа.')}).catch(()=>{});return true}
    const state=sessionView(d,ctx)
    if(list[1]==='page')state.page=Number(list[2]??0);else{state.filter=list[1] as SessionView['filter'];state.page=0}
    saveSessionView(d,ctx,state);await ctx.answerCallbackQuery().catch(()=>{});await show(ctx,await sessionsList(d,state,viewScope(ctx)));return true
  }
  const m = /^sm:([a-z]+)(?::([0-9a-f]+))?(?::(\w+))?$/.exec(data)
  if (!m) return false
  const [, action, id, value] = m
  const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  if (!ctx.from || !can(ctx.from.id, 'control')) {
    await answer(t('Нет доступа.'))
    return true
  }
  if (action === 'owner' || action === 'ownerlaunch') {
    const ownerId = owner()
    if (!ownerId) { await answer(); return true }
    const current = d.userSession(ownerId)
    if (current) { await show(ctx, await sessionScreen(d, current)); await answer(); return true }
    const dir = join(settings.usersDir, ownerId)
    if (action === 'ownerlaunch') {
      // 🚀 <engine>: the chosen CLI becomes the folder's and starts with its own last conversation.
      const chosen = ENGINES[value as keyof typeof ENGINES]
      if (chosen?.available() && chosen.id !== projectEngine(d, dir).engine) setProjectEngine(d, dir, { engine: chosen.id })
      await answer(t('🚀 Запускаю'))
      await launchUserSession(d, ownerId, d.userShortName(ownerId))
      await show(ctx, await sessionsList(d,sessionView(d,ctx),viewScope(ctx)))
      return true
    }
    await show(ctx, { text: `👤 <b>${escapeHtml(d.userShortName(ownerId))}</b>\n\n⏻ ${t('не запущена')}`, kb: launchEngineKb(d, dir, e => `sm:ownerlaunch:${e}`, [[button(t('« К списку'), 'sm:list')]]) })
    await answer()
    return true
  }
  if (action === 'perms') {
    await answer()
    await show(ctx, permissionsScreen(d))
    return true
  }
  if (action === 'list') {
    await show(ctx, await sessionsList(d,sessionView(d,ctx),viewScope(ctx)))
    await answer()
    return true
  }
  const s = id ? d.sessions.get(id) : undefined
  if (!s && id) {
    const replacement = replacementSession(d, id)
    if (replacement) { await answer(t('Сессия перезапущена: откройте актуальную карточку.')); await show(ctx, await sessionScreen(d, replacement)); return true }
  }
  if (!s || s.passive) {
    await answer(t('Сессия уже отключена.'))
    await show(ctx, await sessionsList(d,sessionView(d,ctx),viewScope(ctx)))
    return true
  }
  if (action === 'qclear') {
    let waitingCount = d.store.pendingCount(pendingKeyOf(d, s), settings.pendingTtlH) + codexHeldCount(s)
    waitingCount += (JSON.parse(d.store.get('tokens_held') ?? '[]') as { projectKey: string }[]).filter(h => h.projectKey === s.projectKey).length
    for (const key of d.store.keys('economy:batch:')) {
      const b = JSON.parse(d.store.get(key)!)
      const target = resolveTarget(d, b.chat, b.from)
      if (target.kind === 'session' && target.session === s) waitingCount += b.items.length
    }
    if (value !== 'yes') { await answer(); await show(ctx, { text: `<b>${t('Отменить очередь')}</b>\n\n${escapeHtml(projectTitle(s))}\n${t('В очереди')}: ${waitingCount}`, kb: new InlineKeyboard([[button(t('✅ Да'), `sm:qclear:${s.id}:yes`, 'danger'), button(t('Отмена'), `sm:s:${s.id}`)]]) }); return true }
    for (const key of d.store.keys('economy:batch:')) {
      const b = JSON.parse(d.store.get(key)!)
      const target = resolveTarget(d, b.chat, b.from)
      if (target.kind === 'session' && target.session === s) cancelTextBatch(d, b.chat, b.from)
    }
    for (const key of d.store.keys('ux:delivery:')) {
      const r: Delivery = JSON.parse(d.store.get(key)!)
      if (!['queued', 'launching'].includes(r.phase)) continue
      const target = resolveTarget(d, r.chat, r.userId)
      if (target.kind === 'session' && target.session === s) deliveryPhase(d, { chat_id: r.chat.chatId, message_id: r.messageId }, 'stopped')
    }
    d.store.dropPending(pendingKeyOf(d, s))
    codexTakeHeld(s)
    const held = JSON.parse(d.store.get('tokens_held') ?? '[]') as { projectKey: string }[]
    d.store.set('tokens_held', JSON.stringify(held.filter(h => h.projectKey !== s.projectKey)))
    const broken = JSON.parse(d.store.get('tokens_broken') ?? '[]') as string[]
    d.store.set('tokens_broken', JSON.stringify(broken.filter(p => p !== s.projectKey)))
    await answer(t('Остановлено')); await show(ctx, await sessionScreen(d, s)); return true
  }
  let toast: string | undefined
  if (action === 'g' && (value === 'c' || value === 'n' || value === 'm')) {
    await answer()
    await show(ctx, await sessionScreen(d, s, value))
    return true
  }
  if (action === 'git') {
    await answer()
    await show(ctx, await gitScreen(s))
    return true
  }
  if (action === 'hist') {
    await answer()
    await show(ctx, await historyScreen(s))
    return true
  }
  if (action === 'prm' || action === 'prmd') {
    const rules = projectRules(d, s.projectKey)
    const tool = action === 'prmd' ? rules[Number(value)] : undefined
    if (tool) removeProjectRule(d, s.projectKey, tool)
    await answer(tool ? t('🔐 {tool} снова спрашивается', { tool }) : undefined)
    await show(ctx, rulesScreen(d, s))
    return true
  }
  if (action === 'rs' || action === 'rsok') {
    const c = (await conversationsOf(s, 200)).find(x => dashless(x.id) === value)
    if (!c) { await answer(t('Разговор не найден.')); return true }
    if (action === 'rs') {
      await answer()
      const kb = new InlineKeyboard([[button(t('🕘 Да, продолжить его'), `sm:rsok:${s.id}:${value}`, 'primary'), button(t('Отмена'), `sm:hist:${s.id}`)]])
      await show(ctx, { text: t('Продолжить разговор от {v} в сессии #{id}?\n\n<i>{v2}</i>\n\nТекущий разговор сохранится — вернуться к нему можно так же.', { v: when(c.mtime), id: s.id, v2: escapeHtml(clip(c.prompt || t('(без текста)'), 300)) }), kb })
      return true
    }
    // Codex has no /resume <id>: the session starts again with that conversation.
    if (s.engine === 'codex') {
      await answer(t('♻️ Перезапускаю с этим разговором'))
      void switchSession(d, s, sc => show(ctx, sc).catch(err => d.log(`resume screen failed: ${err}`)), { resume: c.id })
        .catch(err => d.log(`codex resume of ${s.id} failed: ${err}`))
      return true
    }
    const r = await controlAction(d, s, 'resume', c.id)
    await answer(r.toast)
    if (r.sent) await show(ctx, r.screen ?? await sessionScreen(d, s))
    return true
  }
  if (action === 'gdf') {
    const diff = await gitDiff(s.cwd)
    if (diff == null) { await answer(t('Не удалось получить diff.')); return true }
    if (!diff.trim()) { await answer(t('Изменений нет: рабочее дерево чистое.')); return true }
    await answer(t('📄 Отправляю diff'))
    const name = `${s.projectName}${s.branch ? `-${s.branch.replace(/[^\w.-]+/g, '_')}` : ''}.diff`
    const thread = ctx.callbackQuery?.message?.message_thread_id
    await ctx.replyWithDocument(new InputFile(Buffer.from(diff), name), {
      caption: `📄 git diff HEAD · ${projectTitle(s)} · ${t('{n} файл(ов)', { n: diff.split('\n').filter(l => /^diff --git/.test(l)).length })}`,
      ...(thread ? { message_thread_id: thread } : {}),
    })
    return true
  }
  if (action === 'cmpn') {
    // The button under a "context is filling up" notice: keep the notice, drop the button.
    const r = await controlAction(d, s, 'cmp', undefined)
    await answer(r.toast)
    if (r.screen) await show(ctx, r.screen)
    else if (r.sent) await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
    return true
  }
  if (action === 'engre') {
    // Closing and starting takes up to a minute: the button is answered now, the message follows the steps.
    if (!s.tmuxPane) { await answer(t('Сессия не в tmux — команды не отправить.')); return true }
    await answer(t('♻️ Перезапускаю'))
    void switchSession(d, s, sc => show(ctx, sc).catch(err => d.log(`switch screen failed: ${err}`)))
      .catch(err => d.log(`switch session ${s.id} failed: ${err instanceof Error ? err.stack ?? err.message : err}`))
    return true
  }
  if (['rc', 'cmp', 'clr', 'clrok', 'mdl', 'mdldef', 'model', 'eng', 'eff', 'effdef'].includes(action)) {
    const r = await controlAction(d, s, action, value)
    if (r.screen) {
      await answer(r.toast)
      await show(ctx, r.screen)
      return true
    }
    toast = r.toast
  } else if (action === 'aar') {
    s.alwaysAllow.clear()
    toast = t('🔐 Разрешения снова спрашиваются')
  } else if (action === 'stop') {
    toast = stopSession(d, s, 'menu') === 'interrupted' ? t('Команда остановки отправлена') : t('Сейчас нечего останавливать.')
  } else if (action === 'ar' && s.topic) {
    await answer()
    const kb = new InlineKeyboard([[button(t('✅ Да, в архив'), `sm:arok:${s.id}`, 'danger'), button(t('Отмена'), `sm:g:${s.id}:m`)]])
    await show(ctx, { text: t('Архивировать «{v}»? Сессия #{id} будет закрыта, топик — закрыт.', { v: escapeHtml(s.topic.name), id: s.id }), kb })
    return true
  } else if (action === 'arok' && s.topic) {
    const stuck = await archiveTopic(d, s.topic.chatId, s.topic.threadId)
    await answer()
    const text = stuck.length ? t('🗄 Топик в архиве. Сессию #{id} закрыть не смог (не в tmux) — закройте её сами.', { id: s.id }) : t('🗄 В архиве, сессия #{id} закрывается.', { id: s.id })
    await show(ctx, { text, kb: new InlineKeyboard([[button(t('« К списку'), 'sm:list')]]) })
    return true
  } else if (action === 'v' && ['0', '1', '2'].includes(value ?? '')) {
    const c = sessionChat(d, s)
    const v = Number(value) as 0 | 1 | 2
    setPref(c.threadId != null ? `${c.chatId}:${c.threadId}` : c.chatId, { verbose: v })
    toast = t('Подробность: {v}', { v: verboseBadge(v) })
  } else if (action === 'n' && (value === 'off' || value === 'long' || value === 'always')) {
    const c = sessionChat(d, s)
    setPref(c.threadId != null ? `${c.chatId}:${c.threadId}` : c.chatId, { notifyDone: value })
    toast = t('✅ готово: {v}', { v: t(NOTIFY_DONE_INFO[value]) })
  }
  // Stay in the group the button was in.
  const group: CardGroup | undefined = action === 'v' || action === 'n' ? 'n' : action === 'aar' ? 'm' : ['cmp', 'clr', 'clrok', 'model'].includes(action) ? 'c' : undefined
  await show(ctx, await sessionScreen(d, s, group))
  await answer(toast)
  return true
}

/**
 * After a turn: once the context passes CONTEXT_WARN_PCT, offer /compact in
 * the session's chat. Once per filling; the flag resets when it shrinks.
 */
export async function checkContext(d: Daemon, s: Session): Promise<void> {
  const pct = settings.contextWarnPct
  if (pct <= 0 || !s.tmuxPane) return
  const transcript = s.claude.transcript
  const tr = transcript ? await transcriptInfo(transcript) : null
  if (tr?.tokens == null) return
  const fill = (tr.tokens / settings.contextWindow) * 100
  if (fill < pct) { s.contextWarned = false; return }
  if (s.contextWarned || fill > 100) return
  const target = sessionTarget(d, s)
  if (!target) return
  s.contextWarned = true
  const text = t('🧠 Контекст сессии {v} (#{id}) заполнен на <b>{v2}%</b>. Сжать разговор?', { v: escapeHtml(sessionLabel(d, s)), id: s.id, v2: Math.round(fill) })
  await d.bot.api.sendMessage(target.chatId, text, {
    parse_mode: 'HTML',
    ...(target.threadId != null ? { message_thread_id: target.threadId } : {}),
    reply_markup: new InlineKeyboard([[button('🧹 /compact', `sm:cmpn:${s.id}`, 'primary')]]),
  }).catch(err => d.log(`context notice failed: ${err}`))
}

/** Every permission request still waiting, across sessions, with buttons to answer each. */
export function permissionsScreen(d: Daemon): Screen {
  const items = [...d.permissions.entries()]
  const rows: Btn[][] = []
  const lines = [t('🔐 <b>Ждут разрешения</b> ({length})', { length: items.length })]
  for (const [rid, p] of items.slice(0, 15)) {
    const s = d.sessions.get(p.sessionId)
    const who = s ? sessionLabel(d, s) : `#${p.sessionId}`
    const desc = p.description.length > 80 ? p.description.slice(0, 79) + '…' : p.description
    lines.push(`• ${escapeHtml(who)} · <b>${escapeHtml(p.tool_name)}</b>${desc ? ` — ${escapeHtml(desc)}` : ''}`)
    rows.push([button(clip(`✅ ${p.tool_name} · ${who}`, 40), `perm:allow:${rid}`, 'success'), button('❌', `perm:deny:${rid}`, 'danger')])
  }
  if (!items.length) lines.push(t('Ничего не ждёт.'))
  rows.push([button(t('« К сессиям'), 'sm:list'), button('🔄', 'sm:perms'), button(t('« Меню'), 'hub:main')])
  return { text: lines.join('\n'), kb: new InlineKeyboard(rows as never) }
}
