/** Session lifecycle only. No clocks, storage, Telegram, CLI or process effects.
 * Adapters supply event timestamps and act on the returned transition. */
export type Turn = { start: number; replied: boolean; stuck?: boolean; byHook?: boolean }
export type StopRequest = { at: number; phase: 'sent' | 'confirmed' | 'failed'; token?: number }
export type SessionState = {
  status: 'idle' | 'working' | 'waiting'
  lastActivity: number
  turn: Turn | null
  stoppedAt: number | null
  stopRequest?: StopRequest
  stopSequence?: number
  turnEndedAt?: number
}
export type SessionEvent =
  | { type: 'delivered'; at: number; startTurn?: boolean }
  | { type: 'prompt' | 'activity'; at: number }
  | { type: 'ended'; at: number }
  | { type: 'reply_sent' | 'stuck' }
  | { type: 'permission_requested' | 'permission_resolved' }
  | { type: 'stop_requested'; at: number }
  | { type: 'stop_checked'; at: number; token?: number; idle: boolean; checkedAt: number }
  | { type: 'stop_hook'; at: number }
export type Transition = { state: SessionState; accepted: boolean; openedTurn: boolean }

export function reduceSession(previous: SessionState, event: SessionEvent): Transition {
  const state: SessionState = {
    status: previous.status, lastActivity: previous.lastActivity,
    turn: previous.turn ? { ...previous.turn } : null,
    stoppedAt: previous.stoppedAt,
    stopRequest: previous.stopRequest ? { ...previous.stopRequest } : undefined,
    stopSequence: previous.stopSequence, turnEndedAt: previous.turnEndedAt,
  }
  const ignored = (): Transition => ({ state, accepted: false, openedTurn: false })
  let openedTurn = false
  switch (event.type) {
    case 'delivered':
    case 'prompt':
    case 'activity': {
      if (event.type === 'activity' && state.stoppedAt != null) return ignored()
      const restart = event.type !== 'activity' && state.stoppedAt != null
      if (event.type !== 'activity') { state.stoppedAt = null; state.stopRequest = undefined }
      state.lastActivity = event.at
      if (event.type === 'delivered' && event.startTurn === false) break
      if (!state.turn || restart) {
        state.turn = { start: event.at, replied: false, ...(event.type === 'activity' ? { byHook: true } : {}) }
        openedTurn = true
      }
      if (event.type === 'delivered' || state.status === 'idle' || restart) state.status = 'working'
      break
    }
    case 'reply_sent':
      if (!state.turn) return ignored()
      state.turn.replied = true; break
    case 'stuck':
      if (!state.turn) return ignored()
      state.turn.stuck = true; break
    case 'ended': state.turn = null; state.status = 'idle'; state.turnEndedAt = event.at; break
    case 'permission_requested':
      if (state.stoppedAt != null) return ignored()
      state.status = 'waiting'; break
    case 'permission_resolved':
      if (state.stoppedAt != null) return ignored()
      state.status = 'working'; break
    case 'stop_requested':
      if (state.stopRequest?.phase === 'sent') return ignored()
      state.stopSequence = (state.stopSequence ?? 0) + 1
      state.stoppedAt = event.at
      state.stopRequest = { at: event.at, token: state.stopSequence, phase: 'sent' }
      break
    case 'stop_checked':
      if (state.stoppedAt !== event.at || state.stopRequest?.at !== event.at || state.stopRequest.phase !== 'sent' || state.stopRequest.token !== event.token) return ignored()
      state.stopRequest = { ...state.stopRequest, phase: event.idle ? 'confirmed' : 'failed' }
      if (event.idle) { state.status = 'idle'; state.turn = null; state.turnEndedAt = event.checkedAt }
      break
    case 'stop_hook':
      if (state.stoppedAt == null || !state.stopRequest) return ignored()
      state.stopRequest = { ...state.stopRequest, phase: 'confirmed' }
      state.status = 'idle'; state.turn = null; state.turnEndedAt = event.at
      break
  }
  return { state, accepted: true, openedTurn }
}

/** The only adapter operation mutating lifecycle fields; preserves the Session's transport fields. */
export function applySessionEvent(state: SessionState, event: SessionEvent): Transition {
  const result = reduceSession(state, event)
  if (result.accepted) Object.assign(state, result.state)
  return result
}

/** Timestamped old activity must not affect a newer turn. Untimestamped legacy
 * display events after Stop are always ignored; tool events have a grace period. */
export function isLateHook(s: Pick<SessionState, 'turn' | 'turnEndedAt'>, h: { event: string; at?: number }, now: number): boolean {
  if (s.turn) return h.at != null && h.at < s.turn.start && ['PreToolUse', 'PostToolUseFailure', 'MessageDisplay', 'Stop', 'StopFailure'].includes(h.event)
  if (s.turnEndedAt == null || !['PreToolUse', 'PostToolUseFailure', 'MessageDisplay'].includes(h.event)) return false
  if (h.event === 'MessageDisplay') return true
  return h.at != null ? h.at < s.turnEndedAt : now - s.turnEndedAt < 3000
}
