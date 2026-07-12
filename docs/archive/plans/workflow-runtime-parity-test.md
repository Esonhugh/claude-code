# Workflow Runtime Parity Test Plan

## Purpose

Validate real binary-side workflow execution and Agent scheduling parity between `built-claude` and `official-claude`. Dry-run output is not sufficient final evidence.

## Required setup

From repository root:

```sh
make build
```

Expected binaries:

- `./built-claude`
- `./official-claude`

Use `--print --output-format stream-json --verbose --dangerously-skip-permissions` for machine-readable evidence.

## Test artifacts

Use a temporary artifact directory, for example:

```sh
DIR=/tmp/claude-workflow-deep-$(date +%Y%m%d-%H%M%S)
mkdir -p "$DIR"
```

### child-small-workflow.js

```js
export const meta = {
  name: "child-small-workflow",
  description: "Small child workflow for binary-side workflow runtime verification.",
  phases: [{ title: "Child", detail: "One child agent" }],
}

phase("Child")
log("child-small start")
const child = await agent("Reply with exactly: child-small-ok", { label: "child-small-agent", phase: "Child" })
return { child }
```

### parent-small-workflow.js

```js
export const meta = {
  name: "runtime-small-workflow",
  description: "Small real workflow covering phase log args budget agent parallel pipeline workflow.",
  phases: [
    { title: "Parallel", detail: "Two parallel agents" },
    { title: "Pipeline", detail: "One item through one agent stage" },
    { title: "Child", detail: "Child workflow call" },
  ],
}

log("args=" + JSON.stringify(args))
const before = budget.remaining()
phase("Parallel")
const pair = await parallel([
  () => agent("Reply exactly alpha-ok for " + JSON.stringify(args), { label: "alpha", phase: "Parallel" }),
  () => agent("Reply exactly beta-ok for " + JSON.stringify(args), { label: "beta", phase: "Parallel" }),
])
phase("Pipeline")
const piped = await pipeline(["item"], item => agent("Reply exactly pipe-ok for " + item, { label: "pipe", phase: "Pipeline" }))
phase("Child")
const child = await workflow({ scriptPath: "$DIR/child-small-workflow.js" }, { parent: args })
return { before, after: budget.remaining(), pair, piped, child }
```

Replace `$DIR` in the parent file with the actual artifact directory path.

## Test 1 — built small workflow real run

Command:

```sh
./built-claude \
  --debug \
  --debug-file "$DIR/built-small-debug.log" \
  --print 'Call Workflow exactly once with input {"scriptPath":"'$DIR'/parent-small-workflow.js","args":{"case":"built-small"}}. Do not use any other top-level tool.' \
  --tools Workflow,Agent \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  > "$DIR/built-small.jsonl" \
  2> "$DIR/built-small.err"
```

Expected final result:

```json
{"before":null,"after":null,"pair":["alpha-ok","beta-ok"],"piped":["pipe-ok"],"child":{"child":"child-small-ok"}}
```

Expected lifecycle:

- top-level `Workflow` tool_use exists
- Task ID exists
- Run ID exists
- alpha and beta execute in parallel phase
- pipe executes after alpha/beta
- child-small-agent executes after pipe
- no missing/orphan/duplicate notifications

## Test 2 — official small workflow real run

Command:

```sh
./official-claude \
  --debug \
  --debug-file "$DIR/official-small-debug.log" \
  --print 'Call Workflow exactly once with input {"scriptPath":"'$DIR'/parent-small-workflow.js","args":{"case":"official-small"}}. Do not use any other top-level tool. Let it finish and print the Workflow result verbatim.' \
  --tools Workflow,Agent \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  > "$DIR/official-small.jsonl" \
  2> "$DIR/official-small.err"
```

Expected official envelope:

- `Workflow launched in background. Task ID: ...`
- `Summary: ...`
- `Transcript dir: ...`
- `Script file: ...`
- `Run ID: ...`
- resume prompt containing `resumeFromRunId`

Expected final result matches Test 1.

## Test 3 — built vs official parity check

Compare:

- top-level tool name: `Workflow`
- scriptPath input
- workflow parent task event shape
- progress descriptions
- completion notification shape
- final JSON result

Built must match official for official-compatible fields. Built-only extra agent detail is acceptable only if it does not replace parent workflow events or break consumers.

## Test 4 — built deep-research real run

Command:

```sh
./built-claude \
  --debug \
  --debug-file "$DIR/built-deep-research-debug.log" \
  --print 'Call Workflow exactly once with input {"name":"deep-research","args":"Research this narrow question: does the current branch implement WorkflowTool real run support? Keep it concise and finish."}. Do not use any other top-level tool. Let the workflow finish and print the Workflow result verbatim.' \
  --tools Workflow,Agent \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  > "$DIR/built-deep-research.jsonl" \
  2> "$DIR/built-deep-research.err"
```

Expected lifecycle:

- Scope phase starts/completes
- Search phase fanout starts/completes
- Fetch phase fanout starts/completes
- Verify phase starts/completes
- Synthesize phase starts/completes
- all terminal notifications are completed or explicitly failed with workflow status reflecting failure
- no orphan/missing/duplicate terminal notifications

Observed baseline before parity fix:

- `task_started`: 62
- `task_progress`: 90
- `task_notification`: 62
- noncompleted notifications: 0

## Test 5 — built code-review real run

Command:

```sh
./built-claude \
  --debug \
  --debug-file "$DIR/built-code-review-debug.log" \
  --print 'Call Workflow exactly once with input {"name":"code-review","args":"high current branch workflow changes"}. Do not use any other top-level tool. Let the Workflow finish and print the Workflow result verbatim.' \
  --tools Workflow,Agent \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  > "$DIR/built-code-review.jsonl" \
  2> "$DIR/built-code-review.err"
```

Expected:

- top-level `Workflow({name:"code-review"})`
- Scope phase executes
- if no diff is found, result may be `No changes found to review`
- if diff exists, Find/Verify/Synthesize phases execute according to code-review script
- no lifecycle anomalies

## Test 6 — lifecycle audit script

Run against every JSONL artifact:

```sh
python3 - <<'PY'
import json, sys
from collections import defaultdict, Counter
from pathlib import Path
for path in sys.argv[1:]:
    started = {}
    notified = defaultdict(list)
    progress = defaultdict(list)
    counts = Counter()
    for line_no, line in enumerate(Path(path).read_text(errors='ignore').splitlines(), 1):
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get('type') == 'system' and obj.get('subtype') in ('task_started', 'task_progress', 'task_notification'):
            st = obj['subtype']
            counts[st] += 1
            tid = obj.get('task_id')
            if st == 'task_started':
                if tid in started:
                    print(path, 'DUP_START', tid, started[tid][0], line_no)
                started[tid] = (line_no, obj)
            elif st == 'task_notification':
                notified[tid].append((line_no, obj))
            else:
                progress[tid].append((line_no, obj))
    missing = [tid for tid in started if tid not in notified]
    orphan = [tid for tid in notified if tid not in started]
    duplicates = [tid for tid, arr in notified.items() if len(arr) > 1]
    early = [tid for tid, arr in notified.items() if tid in started and min(x[0] for x in arr) < started[tid][0]]
    statuses = Counter(x[1].get('status') for arr in notified.values() for x in arr)
    print(path)
    print('counts=', dict(counts), 'statuses=', dict(statuses))
    print('missing=', missing[:10], 'orphan=', orphan[:10], 'duplicates=', duplicates[:10], 'early=', early[:10])
PY "$DIR"/*.jsonl
```

Pass criteria:

- missing is empty
- orphan is empty
- duplicates is empty
- early is empty
- statuses are all `completed` unless testing failures intentionally

## Test 7 — ultracode workflow UX smoke

Interactive or scripted binary-side check:

- start `./built-claude --dangerously-skip-permissions`
- prompt contains `ultracode` or `effort=ultracode`
- confirm notification text appears: `Dynamic workflow requested for this turn · opt+w to ignore`
- ensure this UX does not launch workflow without explicit opt-in unless ultracode mode is active

## Reporting format

For final validation, report:

```markdown
## Scope
- Target:
- Official version:
- Built version:

## Evidence
- Source-confirmed:
- Runtime-observed:
- Binary-observed:
- Inference / needs verification:

## Lifecycle audit
- Missing notifications:
- Orphan notifications:
- Duplicate terminal notifications:
- Notify-before-start:
- Non-completed terminal notifications:

## Parity result
- Passed:
- Differences:
- Risks:
```
