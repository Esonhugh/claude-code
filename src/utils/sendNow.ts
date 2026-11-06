import type { QueuedCommand } from '../types/textInputTypes.js'
import { logForDebugging } from './debug.js'
import { isSlashCommand } from './messageQueueManager.js'

// Send-now (ctrl+enter) for typed prompts, after official's low-latency submit:
// instead of always cutting the turn, check every 200ms for the cheapest way to
// get the queued prompt in front of the model. Bash and slash commands cannot
// join a running turn, so callers still interrupt for those.
export const SEND_NOW_POLL_MS = 200
const UNMOVABLE_GRACE_TICKS = 2
const MOVED_RESULT_MAX_TICKS = 8

export type SendNowEvidence = {
  turnActive: boolean
  heldByDialog: boolean
  compacting: boolean
  runningToolUseIds: ReadonlySet<string>
  // Foreground shells/agents started by running tool calls that can move to the background.
  movableToolUseIds: readonly string[]
  sampling: boolean
}

export type SendNowDecision =
  | { action: 'stand_by' }
  | { action: 'wait'; reason: 'held_by_dialog' | 'compacting' | 'moved_result' | 'unmovable_grace' | 'not_sampling' }
  | { action: 'background' }
  | { action: 'interrupt' }

export function decideSendNow(
  e: SendNowEvidence & { awaitingMovedResult: boolean; graceOver: boolean },
): SendNowDecision {
  if (!e.turnActive) return { action: 'stand_by' }
  if (e.heldByDialog) return { action: 'wait', reason: 'held_by_dialog' }
  if (e.movableToolUseIds.length > 0) return { action: 'background' }
  if (e.compacting) return { action: 'wait', reason: 'compacting' }
  if (e.awaitingMovedResult) return { action: 'wait', reason: 'moved_result' }
  if (e.runningToolUseIds.size > 0) {
    return e.graceOver ? { action: 'interrupt' } : { action: 'wait', reason: 'unmovable_grace' }
  }
  if (!e.sampling) return { action: 'wait', reason: 'not_sampling' }
  return { action: 'interrupt' }
}

/** A typed prompt that can join the running turn at the next tool boundary. */
export function isSendNowPrompt(cmd: QueuedCommand): boolean {
  return cmd.mode === 'prompt' && cmd.isMeta !== true && cmd.agentId === undefined &&
    (cmd.origin === undefined || cmd.origin.kind === 'human') && !isSlashCommand(cmd)
}

/** A typed command that only runs once the turn has ended, so send-now cuts the turn. */
export function isSendNowCommand(cmd: QueuedCommand): boolean {
  return cmd.agentId === undefined && cmd.isMeta !== true &&
    (cmd.origin === undefined || cmd.origin.kind === 'human') &&
    (cmd.mode === 'bash' || (cmd.mode === 'prompt' && isSlashCommand(cmd)))
}

export type SendNowDeps = {
  hasPrompt: () => boolean
  readEvidence: () => SendNowEvidence
  /** Returns the tool use ids that actually moved to the background. */
  moveToBackground: (toolUseIds: readonly string[]) => string[]
  interrupt: () => void
  schedule: (run: () => void, ms: number) => () => void
}

export function createSendNow(deps: SendNowDeps): { request: () => void; dispose: () => void } {
  let cancelTimer: (() => void) | null = null
  let graceTicks = 0
  let movedResultTicks = 0
  let lastLogged = ''
  const moved = new Set<string>()

  const stop = () => {
    cancelTimer?.()
    cancelTimer = null
    graceTicks = 0
    movedResultTicks = 0
    lastLogged = ''
    moved.clear()
  }

  const tick = () => {
    cancelTimer = null
    if (!deps.hasPrompt()) return stop()
    const evidence = deps.readEvidence()
    for (const id of moved) if (!evidence.runningToolUseIds.has(id)) moved.delete(id)
    const decision = decideSendNow({
      ...evidence,
      awaitingMovedResult: moved.size > 0 && movedResultTicks < MOVED_RESULT_MAX_TICKS,
      graceOver: graceTicks >= UNMOVABLE_GRACE_TICKS,
    })
    const logged = decision.action === 'wait' ? `wait ${decision.reason}` : decision.action
    if (logged !== lastLogged) logForDebugging(`[send-now] ${logged}`)
    lastLogged = logged
    switch (decision.action) {
      case 'stand_by':
        return stop()
      case 'interrupt':
        deps.interrupt()
        return stop()
      case 'wait':
        graceTicks = decision.reason === 'unmovable_grace' ? graceTicks + 1 : 0
        if (decision.reason === 'moved_result') movedResultTicks++
        break
      case 'background': {
        const movedNow = deps.moveToBackground(evidence.movableToolUseIds)
        for (const id of movedNow) moved.add(id)
        if (movedNow.length > 0) {
          graceTicks = 0
        } else if (graceTicks >= UNMOVABLE_GRACE_TICKS) {
          deps.interrupt()
          return stop()
        } else {
          graceTicks++
        }
        break
      }
    }
    cancelTimer = deps.schedule(tick, SEND_NOW_POLL_MS)
  }

  return {
    request: () => {
      if (cancelTimer === null) tick()
    },
    dispose: stop,
  }
}
