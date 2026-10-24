import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { ClaudeAILimits } from '../../services/claudeAiLimits.js'
import { getOauthAccountInfo, isClaudeAISubscriber } from '../../utils/auth.js'
import { formatResetTime } from '../../utils/format.js'
import { logError } from '../../utils/log.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { sleep as defaultSleep } from '../../utils/sleep.js'

// Like official 2.1.303: when a workflow agent stops on a claude.ai usage limit, the run
// pauses until shortly after the reset and re-runs the waiting agents instead of failing them.
// One wait is open at a time; agents that hit the limit meanwhile join it, and new agents
// do not start until it ends.
export const MAX_FUTURE_RESET_WAITS = 2
export const MAX_EXPIRED_RESET_WAITS = 2
export const USAGE_LIMIT_POLL_MS = 30_000
export const USAGE_LIMIT_MAX_WAIT_MS = 86_400_000
const RESUME_JITTER_FLOOR_MS = 30_000
const RESUME_JITTER_CAP_MS = 90_000

export const USAGE_LIMIT_AGENT_LABEL_SUFFIX = ' (after usage limit)'

export type WorkflowUsageLimitWaitStatus = {
  resetsAt: number
  resumeAtMs: number
  waitingAgents: number
}

export type WorkflowUsageLimitWaitEnd = 'resumed' | 'aborted' | 'revoked' | 'failed'

export type WorkflowUsageLimitJoin =
  | { outcome: 'aborted' }
  | { outcome: 'declined'; failureNote: string | undefined }
  | { outcome: 'waiting'; ended: Promise<WorkflowUsageLimitWaitEnd> }

export function isUsageLimitRejection(limits: ClaudeAILimits): boolean {
  return limits.status === 'rejected' &&
    limits.resetsAt !== undefined &&
    Number.isFinite(limits.resetsAt) &&
    limits.isUsingOverage !== true
}

export function formatUsageLimitResets(
  resetsAt: number | undefined,
  showTimezone = false,
): string | undefined {
  const time = formatResetTime(resetsAt, showTimezone)
  if (time === undefined) return undefined
  return /^\d/.test(time) ? `resets at ${time}` : `resets ${time}`
}

export function usageLimitStatusText(resetsAt: number | undefined): string {
  const resets = formatUsageLimitResets(resetsAt)
  return resets === undefined ? 'usage limit' : `usage limit ${resets}`
}

export function usageLimitPausedText(resetsAt: number | undefined): string {
  return `Paused · ${usageLimitStatusText(resetsAt)}`
}

export function isWorkflowUsageLimitWaitEnabled(): boolean {
  return isClaudeAISubscriber() &&
    getOauthAccountInfo()?.billingType !== 'usage_based' &&
    !getIsNonInteractiveSession() &&
    (getInitialSettings().autoContinueAtUsageLimit ?? true)
}

function randomResumeJitterMs(): number {
  return RESUME_JITTER_FLOOR_MS + Math.floor(Math.random() * (RESUME_JITTER_CAP_MS - RESUME_JITTER_FLOOR_MS))
}

function resetTimeForNote(resetsAt: number): string {
  return formatResetTime(resetsAt, true) ?? 'at an unknown time'
}

export class WorkflowUsageLimitWait {
  private status: WorkflowUsageLimitWaitStatus | undefined
  private ended: Promise<WorkflowUsageLimitWaitEnd> | undefined
  private futureWaits = 0
  private expiredWaits = 0
  private readonly signal: AbortSignal | undefined
  private readonly log: (message: string) => void
  private readonly onChange: (status: WorkflowUsageLimitWaitStatus | undefined) => void
  private readonly isEnabled: () => boolean
  private readonly resumeJitterMs: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(options: {
    signal?: AbortSignal
    log: (message: string) => void
    onChange: (status: WorkflowUsageLimitWaitStatus | undefined) => void
    isEnabled?: () => boolean
    resumeJitterMs?: () => number
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  }) {
    this.signal = options.signal
    this.log = options.log
    this.onChange = options.onChange
    this.isEnabled = options.isEnabled ?? isWorkflowUsageLimitWaitEnabled
    this.resumeJitterMs = options.resumeJitterMs ?? randomResumeJitterMs
    this.sleep = options.sleep ?? defaultSleep
  }

  async whenClear(): Promise<void> {
    while (this.ended !== undefined) await this.ended
  }

  join(limits: ClaudeAILimits | undefined): WorkflowUsageLimitJoin {
    try {
      return this.tryJoin(limits)
    } catch (error) {
      logError(error)
      return { outcome: 'declined', failureNote: undefined }
    }
  }

  private tryJoin(limits: ClaudeAILimits | undefined): WorkflowUsageLimitJoin {
    if (this.signal?.aborted) return { outcome: 'aborted' }
    if (limits?.resetsAt === undefined || !isUsageLimitRejection(limits) || !this.isEnabled()) {
      return { outcome: 'declined', failureNote: undefined }
    }
    const now = Date.now()
    const resetMs = limits.resetsAt * 1000
    if (resetMs - now > USAGE_LIMIT_MAX_WAIT_MS) {
      return {
        outcome: 'declined',
        failureNote: `usage limit; resets ${resetTimeForNote(limits.resetsAt)}, too far out to wait for`,
      }
    }
    const resumeAtMs = Math.max(resetMs, now) + this.resumeJitterMs()
    if (this.status !== undefined && this.ended !== undefined) {
      this.status = {
        resetsAt: Math.max(this.status.resetsAt, limits.resetsAt),
        resumeAtMs: Math.max(this.status.resumeAtMs, resumeAtMs),
        waitingAgents: this.status.waitingAgents + 1,
      }
      this.onChange(this.status)
      return { outcome: 'waiting', ended: this.ended }
    }
    const expired = resetMs <= now
    if (expired ? this.expiredWaits >= MAX_EXPIRED_RESET_WAITS : this.futureWaits >= MAX_FUTURE_RESET_WAITS) {
      const count = expired ? MAX_EXPIRED_RESET_WAITS : MAX_FUTURE_RESET_WAITS
      return {
        outcome: 'declined',
        failureNote: `usage limit; resets ${resetTimeForNote(limits.resetsAt)}, and this run already waited for ${count} resets`,
      }
    }
    if (expired) this.expiredWaits++
    else this.futureWaits++
    this.status = { resetsAt: limits.resetsAt, resumeAtMs, waitingAgents: 1 }
    this.ended = this.waitForReset()
    const resets = formatUsageLimitResets(limits.resetsAt, true)
    this.log(`Usage limit reached${resets === undefined ? '' : ` · ${resets}`}. Workflow paused; waiting agents re-run shortly after the reset.`)
    this.onChange(this.status)
    return { outcome: 'waiting', ended: this.ended }
  }

  private async waitForReset(): Promise<WorkflowUsageLimitWaitEnd> {
    let end: WorkflowUsageLimitWaitEnd = 'failed'
    try {
      let enabled = true
      let remaining = this.status!.resumeAtMs - Date.now()
      do {
        await this.sleep(Math.max(0, Math.min(remaining, USAGE_LIMIT_POLL_MS)), this.signal)
        remaining = this.status!.resumeAtMs - Date.now()
        enabled = this.isEnabled()
      } while (!this.signal?.aborted && enabled && remaining > 0)
      end = this.signal?.aborted ? 'aborted' : enabled ? 'resumed' : 'revoked'
    } catch (error) {
      logError(error)
    }
    const waitingAgents = this.status?.waitingAgents ?? 0
    this.status = undefined
    this.ended = undefined
    try {
      this.onChange(undefined)
      const agents = `${waitingAgents} waiting ${waitingAgents === 1 ? 'agent' : 'agents'}`
      if (end === 'resumed') this.log(`Usage limit reset. Re-running ${agents}.`)
      if (end === 'revoked') this.log(`Waiting for usage limits to reset was turned off. ${agents} will not run again.`)
    } catch (error) {
      logError(error)
    }
    return end
  }
}
