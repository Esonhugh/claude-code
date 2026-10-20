import { z } from 'zod/v4'
import {
  addSessionCronTask,
  getSessionCronTasks,
  removeSessionCronTasks,
  setScheduledTasksEnabled,
} from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCronJitterConfig } from '../../utils/cronJitterConfig.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import { isKairosCronEnabled } from '../ScheduleCronTool/prompt.js'
import {
  buildStoppedMessage,
  MAX_WAKEUP_DELAY_SECONDS,
  MIN_WAKEUP_DELAY_SECONDS,
  SCHEDULE_WAKEUP_DESCRIPTION,
  SCHEDULE_WAKEUP_PROMPT,
  SCHEDULE_WAKEUP_TOOL_NAME,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    delaySeconds: semanticNumber(z.number().optional()).describe(
      `Seconds from now to wake up. Clamped to [${MIN_WAKEUP_DELAY_SECONDS}, ${MAX_WAKEUP_DELAY_SECONDS}] by the runtime. Required unless \`stop\` is true.`,
    ),
    reason: z
      .string()
      .optional()
      .describe(
        'One short sentence explaining the chosen delay. Shown to the user. Be specific. Required unless `stop` is true.',
      ),
    prompt: z
      .string()
      .optional()
      .describe(
        'The /loop input to fire on wake-up. Pass the same /loop input verbatim each turn so the next firing re-enters the skill and continues the loop. Required unless `stop` is true.',
      ),
    stop: semanticBoolean(z.boolean().optional()).describe(
      'Set to true to end the dynamic loop immediately instead of scheduling another wakeup. When true, all other fields are ignored and no further wakeups fire.',
    ),
    noop: semanticBoolean(z.boolean().optional()).describe(
      'true = nothing changed (you checked and there is nothing to report). false = something happened worth keeping (edited a file, posted a message, advanced state, surfaced a finding). Required unless `stop` is true.',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    scheduledFor: z
      .number()
      .describe('Epoch ms timestamp when the next wakeup will fire'),
    clampedDelaySeconds: z
      .number()
      .describe('Actual delay used after clamping to runtime bounds'),
    wasClamped: z
      .boolean()
      .describe(
        `True if the requested delaySeconds was outside [${MIN_WAKEUP_DELAY_SECONDS}, ${MAX_WAKEUP_DELAY_SECONDS}]`,
      ),
    stopped: z
      .boolean()
      .optional()
      .describe('True when the model ended the loop via `stop: true`'),
    cancelledWakeups: z
      .number()
      .optional()
      .describe('How many pending dynamic-loop wakeups stop:true cancelled.'),
    reason: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

// Per-prompt loop chains, for the recurringMaxAgeMs age-out. A chain whose
// last wakeup is more than MAX_WAKEUP_DELAY_SECONDS old counts as new.
const loopChains = new Map<
  string,
  { startedAt: number; lastScheduledFor: number }
>()

export function clampWakeupDelay(delaySeconds: number): {
  clamped: number
  wasClamped: boolean
} {
  const rounded = Number.isNaN(delaySeconds)
    ? MIN_WAKEUP_DELAY_SECONDS
    : delaySeconds === Infinity
      ? MAX_WAKEUP_DELAY_SECONDS
      : delaySeconds === -Infinity
        ? MIN_WAKEUP_DELAY_SECONDS
        : Math.round(delaySeconds)
  const clamped = Math.max(
    MIN_WAKEUP_DELAY_SECONDS,
    Math.min(MAX_WAKEUP_DELAY_SECONDS, rounded),
  )
  return {
    clamped,
    wasClamped: !Number.isFinite(delaySeconds) || rounded !== clamped,
  }
}

function pendingLoopWakeupIds(): string[] {
  return getSessionCronTasks()
    .filter(t => t.kind === 'loop')
    .map(t => t.id)
}

/** Cancels every pending dynamic-loop wakeup; returns how many were pending. */
export function cancelLoopWakeups(): number {
  const ids = pendingLoopWakeupIds()
  removeSessionCronTasks(ids)
  loopChains.clear()
  return ids.length
}

export const ScheduleWakeupTool = buildTool({
  name: SCHEDULE_WAKEUP_TOOL_NAME,
  searchHint:
    'self-pace the dynamic /loop: pick a delay before the next tick, or stop/end/cancel the dynamic loop with stop:true (a fixed-interval /loop is a recurring cron — cancel it with CronDelete)',
  maxResultSizeChars: 1000,
  shouldDefer: false,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName: () => 'Loop wakeup',
  isEnabled() {
    return isKairosCronEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    if (input.stop === true) {
      return 'stop the /loop — cancel pending wakeups, schedule nothing'
    }
    return `wake in ${input.delaySeconds}s: ${input.prompt}`
  },
  async description() {
    return SCHEDULE_WAKEUP_DESCRIPTION
  },
  async prompt() {
    return SCHEDULE_WAKEUP_PROMPT
  },
  async validateInput(input) {
    if (input.stop === true) return { result: true }
    if (input.delaySeconds === undefined || input.reason === undefined) {
      return {
        result: false,
        message:
          '`delaySeconds` and `reason` are required when `stop` is not true.',
        errorCode: 1,
      }
    }
    if (input.prompt === undefined || input.prompt.trim() === '') {
      return {
        result: false,
        message: '`prompt` is required when `stop` is not true.',
        errorCode: 2,
      }
    }
    if (input.noop === undefined) {
      return {
        result: false,
        message: '`noop` is required when `stop` is not true.',
        errorCode: 3,
      }
    }
    return { result: true }
  },
  async call({ delaySeconds, reason, prompt, stop }) {
    if (stop === true) {
      return {
        data: {
          scheduledFor: 0,
          clampedDelaySeconds: 0,
          wasClamped: false,
          stopped: true,
          cancelledWakeups: cancelLoopWakeups(),
        },
      }
    }
    const loopPrompt = prompt!
    const now = Date.now()
    const chain = loopChains.get(loopPrompt)
    const chainStartedAt =
      chain === undefined ||
      now > chain.lastScheduledFor + MAX_WAKEUP_DELAY_SECONDS * 1000
        ? now
        : chain.startedAt
    const maxAgeMs = getCronJitterConfig().recurringMaxAgeMs
    if (maxAgeMs > 0 && now - chainStartedAt >= maxAgeMs) {
      cancelLoopWakeups()
      return { data: { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false } }
    }

    const { clamped, wasClamped } = clampWakeupDelay(delaySeconds!)
    const scheduledFor = now + clamped * 1000
    // A new wakeup supersedes any pending one: a loop has one next tick.
    removeSessionCronTasks(pendingLoopWakeupIds())
    const at = new Date(scheduledFor)
    addSessionCronTask({
      id: Math.floor(Math.random() * 0xffffffff)
        .toString(16)
        .padStart(8, '0'),
      cron: `${at.getMinutes()} ${at.getHours()} * * *`,
      prompt: loopPrompt,
      createdAt: now,
      kind: 'loop',
      scheduledFor,
      ...(getTeammateContext()
        ? { agentId: getTeammateContext()!.agentId }
        : {}),
    })
    loopChains.set(loopPrompt, { startedAt: chainStartedAt, lastScheduledFor: scheduledFor })
    setScheduledTasksEnabled(true)
    return {
      data: { scheduledFor, clampedDelaySeconds: clamped, wasClamped, reason },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.stopped === true) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: buildStoppedMessage(output.cancelledWakeups ?? 0),
      }
    }
    if (output.scheduledFor === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content:
          "Wakeup not scheduled. The loop reached its maximum duration — the loop has ended; do not re-issue. Then write the loop's outcome for the user as ordinary visible response text — and end the turn.",
      }
    }
    const time = new Date(output.scheduledFor).toTimeString().slice(0, 8)
    const inSeconds = Math.max(
      0,
      Math.round((output.scheduledFor - Date.now()) / 1000),
    )
    const clampNote = output.wasClamped
      ? ` (clamped to ${output.clampedDelaySeconds}s from your requested value)`
      : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Next wakeup scheduled for ${time} (in ${inSeconds}s)${clampNote}. If you owe the user a status update this tick, write it now as ordinary response text; then end the turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.`,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
