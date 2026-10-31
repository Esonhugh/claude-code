import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { formatDuration } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'

export const MONITOR_TOOL_NAME = 'Monitor'

export const DEFAULT_MONITOR_TIMEOUT_MS = 300_000
export const MAX_MONITOR_TIMEOUT_MS = 3_600_000
const INTERACTIVE_MONITOR_CAP_MS = 1_800_000
const NON_INTERACTIVE_MONITOR_CAP_MS = 600_000

/** Effective deadline cap: 30 minutes interactively, 10 minutes under -p. */
export function getMonitorTimeoutCapMs(): number {
  return getIsNonInteractiveSession()
    ? NON_INTERACTIVE_MONITOR_CAP_MS
    : INTERACTIVE_MONITOR_CAP_MS
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} minutes`
}

export function buildMonitorExpiryMessage(
  timeoutMs: number,
  eventCount: number,
): string {
  const after = formatDuration(timeoutMs, { hideTrailingZeros: true })
  if (eventCount === 0) {
    return `[Monitor expired after ${after} with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]`
  }
  return `[Monitor expired after ${after} with ${eventCount} ${plural(eventCount, 'event')} delivered. Re-arm it if you still need the watch.]`
}

export const MONITOR_COMMAND_DESCRIPTION =
  'Shell command or script. Each stdout line is an event; exit ends the watch.'

export const MONITOR_DESCRIPTION_FIELD =
  'Short human-readable description of what you are monitoring (shown in notifications).'

export function getMonitorPrompt(): string {
  const stderrNote = getIsNonInteractiveSession()
    ? 'stderr only shows its last lines in the notice sent when the script ends'
    : 'stderr goes to the output file (readable via Read)'
  return `Start a background monitor that streams events from a long-running script. Each stdout line is an event delivered to you as a notification while you keep working; events are not replies from the user. Exit ends the watch (the exit code is reported).

Pick by how many notifications you need:
- One ("tell me when the build finishes"): use Bash with \`run_in_background\` and a command that exits when the condition holds, e.g. \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`. Do not use Monitor with \`tail -f\`, \`inotifywait -m\` or \`while true\` for this: they never exit, and \`tail -f log | grep -m 1\` can hang after the match.
- One per occurrence ("every ERROR line"): Monitor with an unbounded command, e.g. \`tail -f app.log | grep --line-buffered ERROR\`, re-armed on expiry.
- One per occurrence until a known end ("each CI check, stop when the run completes"): Monitor with a poll loop that prints new lines and exits when done.

Rules:
- Every pipe stage must flush per line: \`grep --line-buffered\`, \`awk\` with \`fflush()\`. \`| head -N\` delivers nothing until N lines arrive.
- Silence is not success: match failures as well as progress, e.g. \`grep -E --line-buffered "step=|Traceback|Error|FAILED|Killed|OOM"\`, and in poll loops emit every terminal status (succeeded, failed, cancelled, timeout).
- Only stdout is the event stream; ${stderrNote}. Merge with \`2>&1\` for a command you run directly.
- Every line is a conversation message: filter to the lines you would act on. Monitors that emit too much are stopped. Lines within 200ms are batched into one notification.
- In poll loops, tolerate transient failures (\`curl ... || true\`) and poll remote APIs every 30s or more.
- Write a specific \`description\`; it appears in every notification.

The script runs in the same shell environment as Bash. Each monitor expires after \`timeout_ms\` (default ${minutes(DEFAULT_MONITOR_TIMEOUT_MS)}, at most ${minutes(getMonitorTimeoutCapMs())}) with one notice giving the event count; re-arm it to keep watching. Use TaskStop to cancel early.`
}
