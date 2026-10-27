import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { plural } from '../../utils/stringUtils.js'

// Prompt texts of official 2.1.311 /code-review and /simplify, verbatim. The
// ReportFindings-tool variants are left out: the fork has no such tool, so
// the review always returns a JSON array.
const REPORT_FINDINGS_TOOL_NAME = 'ReportFindings'

export type FindingsCap = number | 'all'
type ReviewOutput = (cap: FindingsCap) => string
export type ReviewCell =
  | 'low'
  | 'low-sonnet5'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'o48-low-v1'
  | 'o48-med-v1'
  | 'o48-high-v1'
  | 'o48-xhigh-v1'
  | 'o5-bmin'

export const DIFF_PHASE_0 =
  "## Phase 0 \u2014 Gather the diff\n\nRun `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1`\nif there's no upstream) to get the unified diff under review. If there are\nuncommitted changes, or the range diff is empty, also run `git diff HEAD` and\ninclude the working-tree changes in scope \u2014 the review often runs before the\ncommit. If a PR number, branch name, or file path was passed as an argument,\nreview that target instead. Treat this diff as the review scope.\n"

export const REUSE_BODY = `Flag new code that re-implements something the codebase
already has \u2014 Grep shared/utility modules and files adjacent to the change,
and name the existing helper to call instead.
`

export const SIMPLIFICATION_ANGLE = `### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name
the simpler form that does the same job.
`

export const EFFICIENCY_ANGLE = `### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or
hot paths. Also flag long-lived objects built from closures or captured
environments \u2014 they keep the entire enclosing scope alive for the object's
lifetime (a memory leak when that scope holds large values); prefer a
class/struct that copies only the fields it needs. Name the cheaper
alternative.
`

const CONVENTIONS_ANGLE = `### Conventions (CLAUDE.md)

Find the CLAUDE.md files that govern the changed code: the user-level
~/.claude/CLAUDE.md, the repo-root CLAUDE.md, plus any CLAUDE.md or
CLAUDE.local.md in a directory that is an ancestor of a changed file (a
directory's CLAUDE.md only applies to files at or below it). Read each one
that exists, then check the diff for clear violations of the rules they state.

Only flag a violation when you can quote the exact rule and the exact line
that breaks it \u2014 no style preferences, no vague "spirit of the doc"
inferences. In the finding, name the CLAUDE.md path and quote the rule so the
report can cite it. If no CLAUDE.md applies, return nothing for this angle.
`

export const ALTITUDE_ANGLE = `### Altitude

Check that each change fixes the root cause at the right depth rather than
patching a symptom with a fragile bandaid. Special cases layered on shared
infrastructure are a sign the fix isn't deep enough \u2014 prefer the simpler, more
general change to the underlying mechanism over adding special cases, and name
that change.
`

const ANGLE_A = `### Angle A \u2014 line-by-line diff scan

Read every hunk in the diff, line by line. Then Read the enclosing function for
each hunk \u2014 bugs in unchanged lines of a touched function are in scope (the PR
re-exposes or fails to fix them). For every line ask: what input, state, timing,
or platform makes this line wrong? Look for inverted/wrong conditions,
off-by-one, null/undefined deref, missing \`await\`, falsy-zero checks,
wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.
`

const ANGLE_B = `### Angle B \u2014 removed-behavior auditor

For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established.
If you can't find it, that's a candidate: a removed guard, a dropped error
path, a narrowed validation, a deleted test that was covering a real case.
`

const ANGLE_C = `### Angle C \u2014 cross-file tracer

For each function the diff changes, find its callers (Grep for the symbol) and
check whether the change breaks any call site: a new precondition, a changed
return shape, a new exception, a timing/ordering dependency. Also check callees:
does a parallel change in the same PR make a call unsafe?
`

const ANGLE_D = `### Angle D \u2014 language-pitfall specialist

Scan for the classic pitfalls of the diff's language/framework \u2014 for example:
JS falsy-zero, \`==\` coercion, closure-captured loop var; Python mutable default
args, late-binding closures; Go nil-map write, range-var capture; SQL injection;
timezone/DST drift; float equality. Flag any instance the diff introduces.
`

const ANGLE_E = `### Angle E \u2014 wrapper/proxy correctness

When the PR adds or modifies a type that wraps another (cache, proxy, decorator,
adapter): check that every method routes to the wrapped instance and not back
through a registry/session/global \u2014 e.g. a caching provider holding a
\`delegate\` field that resolves IDs via \`session.get(...)\` instead of
\`delegate.get(...)\` will re-enter the cache or recurse. Also check that the
wrapper forwards all the methods the callers actually use.
`

const NO_AGENT_TOOL_NOTE = `If the ${AGENT_TOOL_NAME} tool is not available in your current tool set, do not error \u2014 perform each angle (and each verification) yourself, sequentially, in this context.`

const ANGLES_ABC = `${ANGLE_A}
${ANGLE_B}
${ANGLE_C}`

const ANGLES_ABCDE = `${ANGLES_ABC}
${ANGLE_D}
${ANGLE_E}`

const REUSE_ANGLE = `### Reuse

The angles above hunt for bugs; this one and the next two hunt for cleanup in
the changed code. ${REUSE_BODY}`

const CLEANUP_SHAPE_NOTE =
  'Cleanup, altitude, and conventions candidates use the same\n`file`/`line`/`summary` shape; in `failure_scenario`, state the concrete\ncost (what is duplicated, wasted, harder to maintain, or which CLAUDE.md rule\nis broken) instead of a crash. Correctness bugs always outrank cleanup,\naltitude, and conventions findings when the output cap forces a cut.\n'

const THREE_STATE_VOTES = `- **CONFIRMED** \u2014 can name the inputs/state that trigger it and the wrong
  output or crash. Quote the line.
- **PLAUSIBLE** \u2014 mechanism is real, trigger is uncertain (timing, env,
  config). State what would confirm it.
- **REFUTED** \u2014 factually wrong (code doesn't say that) or guarded elsewhere.
  Quote the line that proves it.`

const RECALL_BIASED_VOTES = `**PLAUSIBLE by default** \u2014 do not refute a candidate for being "speculative" or
"depends on runtime state" when the state is realistic: concurrency races,
nil/undefined on a rare-but-reachable path (error handler, cold cache, missing
optional field), falsy-zero treated as missing, off-by-one on a boundary the
code does not exclude, retry storms / partial failures, regex/allowlist that
lost an anchor. These are PLAUSIBLE.

**REFUTED** only when constructible from the code: factually wrong (quote the
actual line); provably impossible (type/constant/invariant \u2014 show it); already
handled in this diff (cite the guard); or pure style with no observable effect.`

const VERIFY_THREE_STATE = `## Phase 2 \u2014 Verify (1-vote, 3-state)

Dedup candidates that point at the same line/mechanism, keeping the one with
the most concrete failure scenario. For each remaining candidate, run **one
verifier** via the ${AGENT_TOOL_NAME} tool: give it the diff, the relevant
file(s), and the candidate, and have it return exactly one of:

${THREE_STATE_VOTES}

Keep candidates where the vote is CONFIRMED or PLAUSIBLE.
`

const VERIFY_RECALL_BIASED = `## Phase 2 \u2014 Verify (1-vote, recall-biased)

Dedup near-duplicates (same defect, same location, same reason \u2192 keep one). For
each remaining candidate, run **one verifier** via the ${AGENT_TOOL_NAME} tool:
give it the diff, the relevant file(s), and the candidate; it returns exactly
one of **CONFIRMED / PLAUSIBLE / REFUTED**.

${RECALL_BIASED_VOTES}

Keep **CONFIRMED and PLAUSIBLE**. Drop REFUTED.
`

const SWEEP_FOCUS = `moved/extracted code that dropped a guard
or anchor; second-tier footguns (dataclass default evaluated once, \`hash()\`
non-determinism, lock-scope shrink, predicate methods with side effects);
setup/teardown asymmetry in tests; config defaults flipped.`

const SWEEP_PHASE = `## Phase 3 \u2014 Sweep for gaps

Run **one more finder** as a fresh reviewer who has the verified list. Re-read
the diff and enclosing functions looking ONLY for defects not already listed.
Do not re-derive or re-confirm anything already there \u2014 the job is gaps. Focus
on what the first pass tends to miss: ${SWEEP_FOCUS}

Surface **up to 8 additional candidates**, each naming a defect not already on
the list. If nothing new, return an empty sweep \u2014 do not pad.
`

function findingsCapLabel(cap: FindingsCap): string {
  return cap === 'all'
    ? 'all findings'
    : `\u2264${cap} ${plural(cap, 'finding')}`
}

function findingsCapPhrase(cap: FindingsCap): string {
  return cap === 'all'
    ? '**every finding**'
    : `at most **${cap} ${plural(cap, 'finding')}**`
}

const jsonOutput: ReviewOutput = cap => `## Output

Return findings as a JSON array ${cap === 'all' ? 'with one object for every finding that survives, no maximum' : `of at most ${cap} ${plural(cap, 'object')}`}:

\`\`\`json
[
  {
    "file": "path/to/file.ext",
    "line": 123,
    "summary": "one-sentence statement of the bug",
    "failure_scenario": "concrete inputs/state \u2192 wrong output/crash"
  }
]
\`\`\`

Ranked most-severe first. ${
  cap === 'all'
    ? 'Keep every finding that survives. There is no maximum.'
    : `If more than ${cap} survive, keep the ${cap} most
severe.`
} If nothing survives verification, return \`[]\`. Do not call the
${REPORT_FINDINGS_TOOL_NAME} tool even if it is available - this review's
output contract is the JSON block above.
`

const lowCell = (
  cap: FindingsCap = 4,
): string => `\`low effort \u2192 1 diff pass \u2192 no verify \u2192 ${findingsCapLabel(cap)}\`

## Turn 1 \u2014 read

One tool call: read the unified diff (\`git diff @{upstream}...HEAD; git diff HEAD\`
to cover both committed and uncommitted changes, or \`git diff main...HEAD\` /
the target passed as an argument). Skip test/fixture
hunks (\`test/\`, \`spec/\`, \`__tests__/\`, \`*_test.*\`, \`*.test.*\`,
\`fixtures/\`, \`testdata/\`) \u2014 test-file changes are not reviewed at this level.
No subagents, no full-file reads.

## Turn 2 \u2014 findings

Flag runtime-correctness bugs visible from the hunk alone: inverted/wrong
condition, off-by-one, null/undefined deref where adjacent lines show the value
can be absent, removed guard, falsy-zero check, missing \`await\`,
wrong-variable copy-paste, error swallowed in a catch that should propagate.
Also flag \u2014 still from the hunk alone \u2014 new code that duplicates an existing
helper visible in the diff context, and dead code the diff leaves behind.

Do **not** flag style, naming, perf, missing tests, or anything outside the
hunk.

Output ${findingsCapPhrase(cap)}, most-severe first, one line each:
\`path/to/file.ext:123 \u2014 what's wrong and the concrete failure\`. If nothing
qualifies, output exactly \`(none)\`. Do not call the
${REPORT_FINDINGS_TOOL_NAME} tool even if it is available.
`

const lowSonnet5Cell =
  (): string => `\`low effort \u2192 1 diff pass \u2192 no verify \u2192 \u2265min(files,4) findings\`

## Turn 1 \u2014 read

One tool call: read the unified diff (\`git diff @{upstream}...HEAD; git diff HEAD\`
to cover both committed and uncommitted changes, or \`git diff main...HEAD\` /
the target passed as an argument). Skip test/fixture
hunks (\`test/\`, \`spec/\`, \`__tests__/\`, \`*_test.*\`, \`*.test.*\`,
\`fixtures/\`, \`testdata/\`) \u2014 test-file changes are not reviewed at this level.
No subagents, no full-file reads.

## Turn 2 \u2014 findings

Flag runtime-correctness bugs visible from the hunk alone: inverted/wrong
condition, off-by-one, null/undefined deref where adjacent lines show the value
can be absent, removed guard, falsy-zero check, missing \`await\`,
wrong-variable copy-paste, error swallowed in a catch that should propagate.
Also flag \u2014 still from the hunk alone \u2014 new code that duplicates an existing
helper visible in the diff context, and dead code the diff leaves behind.

Do **not** flag style, naming, perf, missing tests, or anything outside the
hunk.

Target **min(files_changed, 4) findings**, most-severe first, one
line each: \`path/to/file.ext:123 \u2014 what's wrong and the concrete failure\`.
If you have fewer, do one more pass focused on the largest changed file
and on any **removed** code blocks. Output \`(none)\` only if the diff is
trivially correct after that pass.
`

const EIGHT_ANGLES = `${ANGLES_ABC}
${REUSE_ANGLE}
${SIMPLIFICATION_ANGLE}
${EFFICIENCY_ANGLE}
${ALTITUDE_ANGLE}
${CONVENTIONS_ANGLE}`

const INLINE_FALLBACK_NOTE = `The ${AGENT_TOOL_NAME} tool isn't available in this context, so the usual
multi-agent fan-out and subagent verify pass can't run. Work through every
angle below yourself, in this same context, in one pass \u2014 do not skip angles
for lack of fan-out. Re-check each candidate against the diff before keeping
it; drop anything you can't back up with a concrete failure scenario.
`

const INLINE_FALLBACK_SUMMARY = `
State clearly in your summary that this was a single-pass review done without
the ${AGENT_TOOL_NAME} tool, not the full multi-agent fan-out, so whoever reads
it isn't misled about what actually ran.
`

function inlineFallbackCell({
  tag,
  leadIn,
  angleCount,
  angles,
  cap,
  output,
  sweepFocus,
}: {
  tag: string
  leadIn: string
  angleCount: number
  angles: string
  cap: FindingsCap
  output: ReviewOutput
  sweepFocus?: string
}): string {
  const sweep = sweepFocus
    ? `
## Phase 3 \u2014 Sweep for gaps

Take one more pass yourself (same context, no subagent) as a fresh reviewer
who has the deduplicated list. Re-read the diff and enclosing functions
looking ONLY for defects not already listed: ${sweepFocus}
`
    : ''
  return `\`${tag}\`

${leadIn}

${INLINE_FALLBACK_NOTE}
${DIFF_PHASE_0}## Phase 1 \u2014 Find candidates (${angleCount} angles, single pass)

Work through **${angleCount} angles** yourself, in sequence, in this same
context \u2014 do not spawn subagents. Each surfaces candidate findings with
\`file\`, \`line\`, a one-line \`summary\`, and a concrete \`failure_scenario\`.

${angles}
${CLEANUP_SHAPE_NOTE}
## Phase 2 \u2014 Dedup and self-check (no subagent verify)

Dedup near-duplicates (same defect, same location, same reason \u2192 keep one).
Re-check each remaining candidate yourself against the diff before keeping it.
${sweep}
${output(cap)}${INLINE_FALLBACK_SUMMARY}`
}

const mediumCell = (
  output: ReviewOutput,
  agentToolAvailable = true,
  cap: FindingsCap = 8,
): string => {
  if (!agentToolAvailable)
    return inlineFallbackCell({
      tag: `medium effort \u2192 ${AGENT_TOOL_NAME} tool unavailable \u2192 single-pass inline \u2192 ${findingsCapLabel(cap)}`,
      leadIn: `You are reviewing for **precision** at medium effort: every finding you surface
should be one a maintainer would act on.`,
      angleCount: 8,
      angles: EIGHT_ANGLES,
      cap,
      output,
    })
  return `\`medium effort \u2192 3+5 angles \xD7 6 candidates \u2192 1-vote verify \u2192 ${findingsCapLabel(cap)}\`

You are reviewing for **precision** at medium effort: every finding you surface
should be one a maintainer would act on.

${DIFF_PHASE_0}
## Phase 1 \u2014 Find candidates (3 correctness angles + 3 cleanup angles + 1 altitude angle + 1 conventions angle, up to 6 each)

Run **8 independent finder angles** via the ${AGENT_TOOL_NAME} tool. Each
surfaces **up to 6 candidate findings** with \`file\`, \`line\`, a one-line
\`summary\`, and a concrete \`failure_scenario\`. ${NO_AGENT_TOOL_NOTE}

${EIGHT_ANGLES}
${CLEANUP_SHAPE_NOTE}
Pass every candidate with a nameable failure scenario through \u2014 finders that
silently drop half-believed candidates bypass the verify step and are the
dominant cause of misses.

${VERIFY_THREE_STATE}
${output(cap)}`
}

const highCell = (
  output: ReviewOutput,
  agentToolAvailable = true,
  cap: FindingsCap = 10,
): string => {
  if (!agentToolAvailable)
    return inlineFallbackCell({
      tag: `high effort \u2192 ${AGENT_TOOL_NAME} tool unavailable \u2192 single-pass inline \u2192 ${findingsCapLabel(cap)}`,
      leadIn: `You are reviewing for **recall** at high effort: catch every real bug a careful
reviewer would catch in one sitting. At this level, catching real bugs matters
more than avoiding false positives. Err on the side of surfacing.`,
      angleCount: 8,
      angles: EIGHT_ANGLES,
      cap,
      output,
    })
  return `\`high effort \u2192 3+5 angles \xD7 6 candidates \u2192 1-vote verify (recall-biased) \u2192 ${findingsCapLabel(cap)}\`

You are reviewing for **recall** at high effort: catch every real bug a careful
reviewer would catch in one sitting. At this level, catching real bugs matters
more than avoiding false positives. Err on the side of surfacing.

${DIFF_PHASE_0}
## Phase 1 \u2014 Find candidates (3 correctness angles + 3 cleanup angles + 1 altitude angle + 1 conventions angle, up to 6 each)

Run **8 independent finder angles** via the ${AGENT_TOOL_NAME} tool. Each
surfaces **up to 6 candidate findings** with \`file\`, \`line\`, a one-line
\`summary\`, and a concrete \`failure_scenario\`. ${NO_AGENT_TOOL_NOTE}

${EIGHT_ANGLES}
${CLEANUP_SHAPE_NOTE}
Pass every candidate with a nameable failure scenario through \u2014 finders that
silently drop half-believed candidates bypass the verify step and are the
dominant cause of misses.

${VERIFY_RECALL_BIASED}
${output(cap)}`
}

const TEN_ANGLES = `${ANGLES_ABCDE}
${REUSE_ANGLE}
${SIMPLIFICATION_ANGLE}
${EFFICIENCY_ANGLE}
${ALTITUDE_ANGLE}
${CONVENTIONS_ANGLE}`

const recallCell =
  (level: 'xhigh' | 'max') =>
  (
    output: ReviewOutput,
    agentToolAvailable = true,
    cap: FindingsCap = 15,
  ): string => {
    if (!agentToolAvailable)
      return inlineFallbackCell({
        tag: `${level} effort \u2192 ${AGENT_TOOL_NAME} tool unavailable \u2192 single-pass inline \u2192 ${findingsCapLabel(cap)}`,
        leadIn: `You are reviewing for **recall** at ${level === 'max' ? 'maximum' : 'extra-high'} effort: catch every real bug. At
this level, catching real bugs matters more than avoiding false positives \u2014 a
missed bug ships. Err on the side of surfacing.`,
        angleCount: 10,
        angles: TEN_ANGLES,
        cap,
        output,
        sweepFocus: SWEEP_FOCUS,
      })
    return `\`${level} effort \u2192 5+5 angles \xD7 8 candidates \u2192 1-vote verify \u2192 sweep \u2192 ${findingsCapLabel(cap)}\`

You are reviewing for **recall** at ${level === 'max' ? 'maximum' : 'extra-high'} effort: catch every real bug. At
this level, catching real bugs matters more than avoiding false positives \u2014 a
missed bug ships. Err on the side of surfacing.

${DIFF_PHASE_0}
## Phase 1 \u2014 Find candidates (5 correctness angles + 3 cleanup angles + 1 altitude angle + 1 conventions angle, up to 8 each)

Run **10 independent finder angles** via the ${AGENT_TOOL_NAME} tool. Each
surfaces **up to 8 candidate findings**. Do NOT let one angle's conclusions
suppress another's \u2014 if two angles flag the same line for different reasons,
record both. ${NO_AGENT_TOOL_NOTE}

${TEN_ANGLES}
${CLEANUP_SHAPE_NOTE}
${VERIFY_THREE_STATE}
This is recall mode \u2014 a single non-REFUTED vote carries the finding. Do NOT
drop on uncertainty.

${SWEEP_PHASE}
${output(cap)}`
  }

const xhighCell = recallCell('xhigh')

const maxCell = recallCell('max')

const O48_REUSE_ANGLE = `### Reuse

The angles above hunt for bugs; this one and the next two hunt for cleanup in
the changed code. Flag new code that re-implements something the codebase
already has \u2014 Grep shared/utility modules and files adjacent to the change,
and name the existing helper to call instead.
`

const o48LowCell = (cap: FindingsCap = 8) => {
  const floor = cap === 'all' ? 4 : Math.min(4, cap)
  return `\`low effort \u2192 1 diff pass \u2192 no verify \u2192 ${findingsCapLabel(cap)}\`

## Turn 1 \u2014 read

One tool call: read the unified diff (\`git diff @{upstream}...HEAD; git diff HEAD\`
to cover both committed and uncommitted changes, or \`git diff main...HEAD\` /
the target passed as an argument). No subagents, no full-file reads.

## Turn 2 \u2014 findings

Flag runtime-correctness bugs visible from the hunk alone: inverted/wrong
condition, off-by-one, null/undefined deref where adjacent lines show the value
can be absent, removed guard, falsy-zero check, missing \`await\`,
wrong-variable copy-paste, error swallowed in a catch that should propagate.
Also flag \u2014 still from the hunk alone \u2014 new code that duplicates an existing
helper visible in the diff context, and dead code the diff leaves behind.

Do **not** flag style, naming, perf, missing tests, or anything outside the
hunk.

Output ${findingsCapPhrase(cap)}, most-severe first, one line each:
\`path/to/file.ext:123 \u2014 what's wrong and the concrete failure\`.
Target at least min(files_changed, ${floor}) findings \u2014 if you see fewer, widen to other hunks in the same diff before stopping. If fewer than ${floor} genuine findings exist, emit what you have.
`
}

const withFindingsFloor =
  (output: ReviewOutput, defaultCap: number): ReviewOutput =>
  cap => {
    const floor = Math.max(
      1,
      Math.floor((cap === 'all' ? defaultCap : Math.min(cap, defaultCap)) / 2),
    )
    return output(cap)
      .replace(
        `## Output
`,
        `## Output

Target **at least ${floor} ${plural(floor, 'finding')}**. If fewer genuine findings exist, emit what you have \u2014 do not invent to hit the floor.
`,
      )
      .replace(/nothing survives verification/g, 'nothing survives')
  }

const O48_ANGLES_ABC = `### Angle A \u2014 line-by-line diff scan

Read every hunk in the diff, line by line. Then Read the enclosing function for
each hunk \u2014 bugs in unchanged lines of a touched function are in scope (the PR
re-exposes or fails to fix them). For every line ask: what input, state, timing,
or platform makes this line wrong? Look for inverted/wrong conditions,
off-by-one, null/undefined deref, missing \`await\`, falsy-zero checks,
wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.

### Angle B \u2014 removed-behavior auditor

For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established.
If you can't find it, that's a candidate: a removed guard, a dropped error
path, a narrowed validation, a deleted test that was covering a real case.

### Angle C \u2014 cross-file tracer

For each function the diff changes, find its callers (Grep for the symbol) and
check whether the change breaks any call site: a new precondition, a changed
return shape, a new exception, a timing/ordering dependency. Also check callees:
does a parallel change in the same PR make a call unsafe?
`

const o48InlineCell =
  (tag: string, leadIn: string, defaultCap: number) =>
  (
    output: ReviewOutput,
    cap: FindingsCap = defaultCap,
  ): string => `\`${tag} \u2192 ${findingsCapLabel(cap)}\`

${leadIn}

${DIFF_PHASE_0}
## Phase 1 \u2014 Find candidates (3 correctness angles + 3 cleanup angles + 1 altitude angle + 1 conventions angle, up to 6 each)

Run **8 independent finder angles** in sequence yourself, in THIS context \u2014 do NOT spawn subagents for them. Each
surfaces **up to 6 candidate findings** with \`file\`, \`line\`, a one-line
\`summary\`, and a concrete \`failure_scenario\`.

${O48_ANGLES_ABC}
${O48_REUSE_ANGLE}
${SIMPLIFICATION_ANGLE}
${EFFICIENCY_ANGLE}
${ALTITUDE_ANGLE}
${CONVENTIONS_ANGLE}
${CLEANUP_SHAPE_NOTE}
Pass every candidate with a nameable failure scenario through \u2014 finders that
silently drop half-believed candidates are the dominant cause of misses.

## Phase 2 \u2014 Dedup only (no verify)

Pool all candidates. Dedup near-duplicates only (same defect, same location, same reason \u2192 keep one). Do NOT run verifiers; do NOT re-judge. Sort by severity.

${withFindingsFloor(output, defaultCap)(cap)}`

const o48MediumCell = o48InlineCell(
  'medium effort \u2192 8 inline angles \u2192 dedup (no verify)',
  `You are reviewing for **correctness bugs**: surface every plausible bug. At this
level, catching real bugs matters more than avoiding false positives \u2014 err on
the side of surfacing.`,
  8,
)

const o48HighCell = o48InlineCell(
  'high effort \u2192 8 inline angles \u2192 dedup (no verify)',
  `You are reviewing for **recall** at high effort: catch every real bug a careful
reviewer would catch in one sitting. At this level, catching real bugs matters
more than avoiding false positives. Err on the side of surfacing.`,
  10,
)

const o48XhighCell = (
  output: ReviewOutput,
  cap: FindingsCap = 15,
): string => `\`xhigh effort \u2192 10 inline angles \u2192 dedup (no verify) \u2192 sweep \u2192 ${findingsCapLabel(cap)}\`

You are reviewing for **recall** at extra-high effort: catch every real bug. At
this level, catching real bugs matters more than avoiding false positives \u2014 a
missed bug ships. Err on the side of surfacing.

${DIFF_PHASE_0}
## Phase 1 \u2014 Find candidates (5 correctness angles + 3 cleanup angles + 1 altitude angle + 1 conventions angle, up to 8 each)

Run **10 independent finder angles** in sequence yourself, in THIS context \u2014 do NOT spawn subagents for them. Each
surfaces **up to 8 candidate findings**. Do NOT let one angle's conclusions
suppress another's \u2014 if two angles flag the same line for different reasons,
record both.

${O48_ANGLES_ABC}
### Angle D \u2014 language-pitfall specialist

Scan for the classic pitfalls of the diff's language/framework \u2014 for example:
JS falsy-zero, \`==\` coercion, closure-captured loop var; Python mutable default
args, late-binding closures; Go nil-map write, range-var capture; SQL injection;
timezone/DST drift; float equality. Flag any instance the diff introduces.

### Angle E \u2014 wrapper/proxy correctness

When the PR adds or modifies a type that wraps another (cache, proxy, decorator,
adapter): check that every method routes to the wrapped instance and not back
through a registry/session/global \u2014 e.g. a caching provider holding a
\`delegate\` field that resolves IDs via \`session.get(...)\` instead of
\`delegate.get(...)\` will re-enter the cache or recurse. Also check that the
wrapper forwards all the methods the callers actually use.

${O48_REUSE_ANGLE}
${SIMPLIFICATION_ANGLE}
${EFFICIENCY_ANGLE}
${ALTITUDE_ANGLE}
${CONVENTIONS_ANGLE}
${CLEANUP_SHAPE_NOTE}
## Phase 2 \u2014 Dedup only (no verify)

Pool all candidates. Dedup near-duplicates only (same defect, same location, same reason \u2192 keep one). Do NOT run verifiers; do NOT re-judge. Sort by severity. Do NOT drop on uncertainty.

## Phase 3 \u2014 Sweep for gaps

Take one more pass (same context \u2014 no subagent) as a fresh reviewer who has the deduplicated list. Re-read
the diff and enclosing functions looking ONLY for defects not already listed.
Do not re-derive or re-confirm anything already there \u2014 the job is gaps. Focus
on what the first pass tends to miss: moved/extracted code that dropped a guard
or anchor; second-tier footguns (dataclass default evaluated once, \`hash()\`
non-determinism, lock-scope shrink, predicate methods with side effects);
setup/teardown asymmetry in tests; config defaults flipped.

Surface **up to 8 additional candidates**, each naming a defect not already on
the list. If nothing new, return nothing from this phase \u2014 do not pad.

${withFindingsFloor(output, 15)(cap)}`

const o5MinimalCell = (
  cap: FindingsCap = 15,
): string => `\`minimal prompt \u2192 single careful diff pass \u2192 ${findingsCapLabel(cap)}\`

You are reviewing a pull request for real bugs. Run \`git diff @{upstream}...HEAD\` (or \`git diff main...HEAD\` / \`git diff HEAD~1\`
if there's no upstream) to get the unified diff under review. If there are
uncommitted changes, or the range diff is empty, also run \`git diff HEAD\` and
include the working-tree changes in scope \u2014 the review often runs before the
commit. If a PR number, branch name, or file path was passed as an argument,
review that target instead. Treat this diff as the review scope.

Review the diff as a careful senior engineer would: read every hunk, open the surrounding files for context as needed (Read, Grep, git log/blame/show), and hunt for correctness issues \u2014 wrong or inverted conditions, off-by-one, null/undefined dereference, missing \`await\`, dropped error handling, removed guards or validations, broken callers of changed functions, races. Prefer real failure modes over style; every finding needs a concrete scenario in which the code misbehaves.

When you are done, submit ${cap === 'all' ? 'every finding' : `at most ${cap} ${plural(cap, 'finding')}`} via the ${REPORT_FINDINGS_TOOL_NAME} tool, filling its fields as defined \u2014 for each: the file path and start line, a severity, and a comment that states the issue and the concrete scenario in which the code misbehaves. Quality over quantity: include everything you genuinely believe is a real issue, and nothing you don't.

After the tool call, also restate the findings in your final reply \u2014 one line each, \`file:line \u2014 summary\` \u2014 so they stay visible in sessions that do not render tool output.
`

export const SIMPLIFY_FAN_OUT = `\`/simplify \u2192 4 cleanup agents in parallel \u2192 apply the fixes\`

You are improving the quality of the changed code, not hunting for bugs. Review
it for reuse, simplification, efficiency, and altitude issues, then fix what you
find. Do not look for correctness bugs \u2014 that is what \`/code-review\` is for.

${DIFF_PHASE_0}
## Phase 1 \u2014 Review (4 cleanup agents in parallel)

Launch **4 independent review agents** via the ${AGENT_TOOL_NAME} tool, all in a
single message so they run concurrently. Pass each agent the diff and one of
the four angles below. Each returns its findings with \`file\`, \`line\`, a
one-line \`summary\`, and the concrete cost (what is duplicated, wasted, or
harder to maintain).

### Reuse

${REUSE_BODY}
${SIMPLIFICATION_ANGLE}
${EFFICIENCY_ANGLE}
${ALTITUDE_ANGLE}
## Phase 2 \u2014 Apply the fixes

Wait for all four agents to complete, dedup findings that point at the same
line or mechanism, and fix each remaining one directly. Skip any finding whose
fix would change intended behavior, require changes well outside the reviewed
diff, or that you judge to be a false positive \u2014 note the skip rather than
arguing with it. Finish with a brief summary of what was fixed and what was
skipped (or confirm the code was already clean).
`

export const SIMPLIFY_INLINE = `\`/simplify \u2192 ${AGENT_TOOL_NAME} tool unavailable \u2192 single-pass inline cleanup \u2192 apply the fixes\`

You are improving the quality of the changed code, not hunting for bugs. Review
it for reuse, simplification, efficiency, and altitude issues, then fix what you
find. Do not look for correctness bugs \u2014 that is what \`/code-review\` is for.

The ${AGENT_TOOL_NAME} tool isn't available in this context, so the usual
4-agent fan-out can't run. Work through all four angles below yourself, in
this same context, in one pass \u2014 do not skip an angle for lack of fan-out.

${DIFF_PHASE_0}
## Phase 1 \u2014 Review (4 cleanup angles, single pass)

Review the diff against each angle below in turn. For each, note findings with
\`file\`, \`line\`, a one-line \`summary\`, and the concrete cost (what is
duplicated, wasted, or harder to maintain).

### Reuse

${REUSE_BODY}
${SIMPLIFICATION_ANGLE}
${EFFICIENCY_ANGLE}
${ALTITUDE_ANGLE}
## Phase 2 \u2014 Apply the fixes

Dedup findings that point at the same line or mechanism, and fix each
remaining one directly. Skip any finding whose fix would change intended
behavior, require changes well outside the reviewed diff, or that you judge to
be a false positive \u2014 note the skip rather than arguing with it. Finish with a
brief summary of what was fixed and what was skipped (or confirm the code was
already clean). State clearly in your summary that this was a single-pass
review done without the ${AGENT_TOOL_NAME} tool, not the full 4-agent
fan-out, so whoever reads it isn't misled about what actually ran.
`

export function renderReviewCell(
  cell: ReviewCell,
  agentToolAvailable: boolean,
  cap: FindingsCap | undefined,
): string {
  switch (cell) {
    case 'low':
      return lowCell(cap)
    case 'low-sonnet5':
      return lowSonnet5Cell()
    case 'medium':
      return mediumCell(jsonOutput, agentToolAvailable, cap)
    case 'high':
      return highCell(jsonOutput, agentToolAvailable, cap)
    case 'xhigh':
      return xhighCell(jsonOutput, agentToolAvailable, cap)
    case 'max':
      return maxCell(jsonOutput, agentToolAvailable, cap)
    case 'o48-low-v1':
      return o48LowCell(cap)
    case 'o48-med-v1':
      return o48MediumCell(jsonOutput, cap)
    case 'o48-high-v1':
      return o48HighCell(jsonOutput, cap)
    case 'o48-xhigh-v1':
      return o48XhighCell(jsonOutput, cap)
    case 'o5-bmin':
      return o5MinimalCell(cap)
  }
}
