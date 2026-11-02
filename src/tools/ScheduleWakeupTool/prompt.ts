import { CRON_DELETE_TOOL_NAME } from '../ScheduleCronTool/prompt.js'

export const SCHEDULE_WAKEUP_TOOL_NAME = 'ScheduleWakeup'
export const MIN_WAKEUP_DELAY_SECONDS = 60
export const MAX_WAKEUP_DELAY_SECONDS = 3600

export const SCHEDULE_WAKEUP_DESCRIPTION =
  'Schedule when to resume work in /loop dynamic mode (always pass the `prompt` arg unless stopping). Call before ending the turn to keep the loop alive; call with `stop: true` to end the loop immediately.'

export const SCHEDULE_WAKEUP_PROMPT = `Schedule when to resume work in /loop dynamic mode: the user ran /loop without an interval and wants you to self-pace a task.

- Pass the same /loop prompt back via \`prompt\` each turn so the next firing repeats the task. To end the loop, call with only \`stop: true\`.
- Set \`noop: true\` when nothing changed ("still waiting"), \`noop: false\` when you edited, posted, advanced state or found something. Omit it when stopping.
- \`reason\`: one specific sentence shown to the user ("watching CI run", not "waiting").

Picking \`delaySeconds\` (clamped to [${MIN_WAKEUP_DELAY_SECONDS}, ${MAX_WAKEUP_DELAY_SECONDS}]):
- Work the harness tracks (background commands, agents) re-invokes you when it finishes, so do not poll it; set a 1200s+ fallback in case it hangs.
- External state the harness cannot see (CI, a deploy, a remote queue): match how fast that state changes.
- Idle ticks: 1200-1800s. Never wake just to keep the prompt cache warm; with a 5-minute cache, prefer 270s over 300s when polling, and one long wait over repeated ~300s ones.
`

export function buildStoppedMessage(cancelledWakeups: number): string {
  const tail =
    'If you armed a Monitor for this loop, TaskStop it now. Then write the loop\'s outcome for the user as ordinary visible response text — and end the turn.'
  if (cancelledWakeups === 0) {
    return `Loop stopped — any dynamic loop in this session is ended; there was no pending wakeup to cancel. If you are running a fixed-interval /loop (a recurring cron), it is NOT stopped by this call — cancel it with ${CRON_DELETE_TOOL_NAME}. ${tail}`
  }
  return `Loop stopped — cancelled ${cancelledWakeups} pending wakeup(s); no further dynamic-loop wakeups scheduled. ${tail}`
}
