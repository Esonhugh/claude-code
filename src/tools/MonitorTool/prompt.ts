import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { formatDuration } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'

export const MONITOR_TOOL_NAME = 'Monitor'

export const DEFAULT_MONITOR_TIMEOUT_MS = 300_000
export const MAX_MONITOR_TIMEOUT_MS = 3_600_000
const INTERACTIVE_MONITOR_CAP_MS = 1_800_000
const NON_INTERACTIVE_MONITOR_CAP_MS = 600_000

/** Like official 2.1.303, Monitor is offered only behind tengu_amber_sentinel. */
export function isMonitorToolEnabled(): boolean {
  return (
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_sentinel', false) &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)
  )
}

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
    ? 'Stderr does not trigger notifications; you see only its last lines, in the notice sent when the script ends'
    : 'Stderr goes to the output file (readable via Read) but does not trigger notifications'
  return `Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Pick by how many notifications you need:
- **One** ("tell me when the server is ready / the build finishes") → use **Bash with \`run_in_background\`** and a command that exits when the condition is true, e.g. \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`. You get a single completion notification when it exits.
- **One per occurrence, until the monitor expires (re-arm to continue)** ("tell me every time an ERROR line appears") → Monitor with an unbounded command (\`tail -f\`, \`inotifywait -m\`, \`while true\`).
- **One per occurrence, until a known end** ("emit each CI step result, stop when the run completes") → Monitor with a command that emits lines and then exits.

Your script's stdout is the event stream. Each line becomes a notification. Exit ends the watch.

  # Each matching log line is an event
  tail -f /var/log/app.log | grep --line-buffered "ERROR"

  # Each file change is an event
  inotifywait -m --format '%e %f' /watched/dir

  # Poll GitHub for new PR comments and emit one line per new comment
  last=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  while true; do
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    gh api "repos/owner/repo/issues/123/comments?since=$last" --jq '.[] | "\\(.user.login): \\(.body)"'
    last=$now; sleep 30
  done

  # Node script that emits events as they arrive (e.g. WebSocket listener)
  node watch-for-events.js

  # Per-occurrence with a natural end: emit each CI check as it lands, exit when the run completes
  prev=""
  while true; do
    s=$(gh pr checks 123 --json name,bucket)
    cur=$(jq -r '.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"' <<<"$s" | sort)
    comm -13 <(echo "$prev") <(echo "$cur")
    prev=$cur
    jq -e 'all(.bucket!="pending")' <<<"$s" >/dev/null && break
    sleep 30
  done

**Don't use an unbounded command for a single notification.** \`tail -f\`, \`inotifywait -m\`, and \`while true\` never exit on their own, so the monitor stays armed until timeout even after the event has fired. For "tell me when X is ready," use Bash \`run_in_background\` with an \`until\` loop instead (one notification, ends in seconds). Note that \`tail -f log | grep -m 1 ...\` does *not* fix this: if the log goes quiet after the match, \`tail\` never receives SIGPIPE and the pipeline hangs anyway.

**Script quality:**
- Every pipe stage must flush per line or matches sit in its buffer unseen: \`grep\` needs \`--line-buffered\`, \`awk\` needs \`fflush()\`. \`head\` cannot flush at all — \`| head -N\` delivers nothing until N matches accumulate, then ends the stream.
- In poll loops, handle transient failures (\`curl ... || true\`) — one failed request shouldn't kill the monitor.
- Poll intervals: 30s+ for remote APIs (rate limits), 0.5-1s for local checks.
- Write a specific \`description\` — it appears in every notification ("errors in deploy.log" not "watching logs").
- Only stdout is the event stream. ${stderrNote} — for a command you run directly (e.g. \`python train.py 2>&1 | grep --line-buffered ...\`), merge stderr with \`2>&1\` so its failures reach your filter. (No effect on \`tail -f\` of an existing log — that file only contains what its writer redirected.)

**Coverage — silence is not success.** When watching a job or process for an outcome, your filter must match every terminal state, not just the happy path. A monitor that greps only for the success marker stays silent through a crashloop, a hung process, or an unexpected exit — and silence looks identical to "still running." Before arming, ask: *if this process crashed right now, would my filter emit anything?* If not, widen it.

  # Wrong — silent on crash, hang, or any non-success exit
  tail -f run.log | grep --line-buffered "elapsed_steps="

  # Right — one alternation covering progress + the failure signatures you'd act on
  tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"

For poll loops checking job state, emit on every terminal status (\`succeeded|failed|cancelled|timeout\`), not just success. If you cannot confidently enumerate the failure signatures, broaden the grep alternation rather than narrow it — some extra noise is better than missing a crashloop.

**Output volume**: Every stdout line is a conversation message, so the filter should be selective — but selective means "the lines you'd act on," not "only good news." Never pipe raw logs; filter to exactly the success and failure signals you care about. Monitors that produce too many events are automatically stopped; restart with a tighter filter if this happens.

Stdout lines within 200ms are batched into a single notification, so multiline output from a single event groups naturally.

The script runs in the same shell environment as Bash. Exit ends the watch (exit code is reported). Every monitor expires after \`timeout_ms\` (default ${minutes(DEFAULT_MONITOR_TIMEOUT_MS)}, at most ${minutes(getMonitorTimeoutCapMs())}): it is killed and you get one notice with the event count. Re-arm it if you still need the watch; for a long watch (PR monitoring, log tails) set \`timeout_ms\` to the maximum and re-arm on each expiry, and widen the filter if an expiry with no events was unexpected. Use TaskStop to cancel early.`
}
