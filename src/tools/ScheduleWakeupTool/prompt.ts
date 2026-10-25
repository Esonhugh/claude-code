import { CRON_DELETE_TOOL_NAME } from '../ScheduleCronTool/prompt.js'

export const SCHEDULE_WAKEUP_TOOL_NAME = 'ScheduleWakeup'
export const MIN_WAKEUP_DELAY_SECONDS = 60
export const MAX_WAKEUP_DELAY_SECONDS = 3600

export const SCHEDULE_WAKEUP_DESCRIPTION =
  'Schedule when to resume work in /loop dynamic mode (always pass the `prompt` arg unless stopping). Call before ending the turn to keep the loop alive; call with `stop: true` to end the loop immediately.'

export const SCHEDULE_WAKEUP_PROMPT = `Schedule when to resume work in /loop dynamic mode — the user invoked /loop without an interval, asking you to self-pace iterations of a specific task.

Do NOT schedule a short-interval wakeup to poll for background work you started — when harness-tracked work finishes, you are re-invoked automatically, so polling is wasted. Instead schedule a long fallback (1200s+) so the loop survives if the work hangs or never notifies. The exception is external work the harness cannot track (a CI run, a deploy, a remote queue) — there, pick a delay matched to how fast that state actually changes.

Pass the same /loop prompt back via \`prompt\` each turn so the next firing repeats the task. To end the loop, call this tool with \`stop: true\` (omit every other field) — the loop ends immediately and no further wakeups fire.

Set \`noop: true\` if nothing changed — you checked and there's nothing to report ("no change", "still waiting", "quiet hold"). Set \`noop: false\` if something happened worth keeping — you edited a file, posted a message, advanced state, or surfaced a finding. Omit \`noop\` when stopping (\`stop: true\`).

## Picking delaySeconds

The prompt cache decides how expensive a wake-up is: waking inside the cache TTL re-reads your conversation context cached (fast, cheap); waking past it re-reads everything uncached. Many providers default to a 5-minute TTL.

Never schedule extra wakeups just to keep the cache warm — they cost more than the cache miss they avoid. Match the delay to what you're actually waiting for: when actively polling external state the harness can't notify you about (a CI run, a deploy, a remote queue), pick the delay from how fast that state actually changes; for idle ticks with no specific signal to watch, default to **1200s–1800s** (20–30 min) — the user can always interrupt if they need you sooner.

On a 5-minute TTL, two refinements: under 300s (60s–270s) the cache stays warm, so prefer 270s over 300s when actively polling (300s is the worst-of-both — you pay the miss without amortizing it); and commit to 1200s+ rather than repeated ~300s waits, so one cache miss buys a long wait.

The runtime clamps to [${MIN_WAKEUP_DELAY_SECONDS}, ${MAX_WAKEUP_DELAY_SECONDS}], so you don't need to clamp yourself.

## The reason field

One short sentence on what you chose and why. Shown back to the user. "watching CI run" beats "waiting." The user reads this to understand what you're doing without having to predict your cadence in advance — make it specific.
`

export function buildStoppedMessage(cancelledWakeups: number): string {
  const tail =
    'If you armed a Monitor for this loop, TaskStop it now. Then write the loop\'s outcome for the user as ordinary visible response text — and end the turn.'
  if (cancelledWakeups === 0) {
    return `Loop stopped — any dynamic loop in this session is ended; there was no pending wakeup to cancel. If you are running a fixed-interval /loop (a recurring cron), it is NOT stopped by this call — cancel it with ${CRON_DELETE_TOOL_NAME}. ${tail}`
  }
  return `Loop stopped — cancelled ${cancelledWakeups} pending wakeup(s); no further dynamic-loop wakeups scheduled. ${tail}`
}
