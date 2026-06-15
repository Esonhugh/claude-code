import type { WorkflowSpec } from '../workflowSpec.js'

const CODE_REVIEW_SCRIPT = String.raw`export const meta = {
  name: "code-review",
  description: "Workflow-backed code review — one finder agent per review angle, an independent verifier for every candidate, then a ranked, capped findings report.",
  whenToUse: "Review current branch changes at high, xhigh, or max effort. Pass args as \"<level> [target]\" — level is high, xhigh, or max; target is an optional PR number, branch, ref range, path, or free-form review instructions.",
  phases: [
    { title: "Scope", detail: "Pin the diff command, changed files, and conventions" },
    { title: "Find", detail: "One finder agent per review angle, streaming into verify" },
    { title: "Verify", detail: "One independent verifier per candidate — CONFIRMED / PLAUSIBLE / REFUTED" },
    { title: "Sweep", detail: "Fresh finder hunting only for gaps at xhigh/max" },
    { title: "Synthesize", detail: "Merge duplicates, rank, cap the report" },
  ],
}

const LEVEL_PARAMS = {
  high: { correctnessAngles: 3, perAngle: 6, maxFindings: 10, sweep: false },
  xhigh: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
  max: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
}
const MAX_VERIFY = 25
const SWEEP_MAX = 8

const RAW_ARGS = (typeof args === "string" ? args : "").trim()
const FIRST = RAW_ARGS.split(/\s+/)[0] || ""
const FIRST_IS_LEVEL = Object.prototype.hasOwnProperty.call(LEVEL_PARAMS, FIRST)
const LEVEL = FIRST_IS_LEVEL ? FIRST : "high"
const TARGET = FIRST_IS_LEVEL ? RAW_ARGS.slice(FIRST.length).trim() : RAW_ARGS
const P = LEVEL_PARAMS[LEVEL]

const CORRECTNESS_ANGLES = [
  {
    label: "angle-A",
    text: "Correctness: changed runtime behavior, data loss, crashes, race conditions, async ordering, stale state, missing awaits, off-by-one boundaries, and null/undefined paths.",
  },
  {
    label: "angle-B",
    text: "Integration: contracts between modules, API shape changes, serialization, persistence, migrations, environment assumptions, permission boundaries, and hook/tool behavior.",
  },
  {
    label: "angle-C",
    text: "Regression: behavior users already rely on, CLI/UI compatibility, command parsing, resume/cache semantics, and test coverage that no longer exercises the changed path.",
  },
  {
    label: "angle-D",
    text: "Edge cases: empty input, missing optional fields, duplicate identifiers, unusual but valid paths, partial failures, retry behavior, and fallback branches.",
  },
  {
    label: "angle-E",
    text: "Security and safety: command injection, path traversal, unsafe shell composition, permission bypass, secret exposure, destructive operations, and external side effects.",
  },
]

const CLEANUP_ANGLES = [
  {
    label: "reuse",
    text: "Reuse: identify duplicate logic introduced by the change when an existing helper or framework primitive should be used instead. Only report if it has correctness or maintenance impact.",
    kind: "cleanup",
  },
  {
    label: "simplification",
    text: "Simplification: find over-complicated control flow, speculative abstractions, unnecessary compatibility shims, or helpers created for one-off use. Only report actionable simplifications.",
    kind: "cleanup",
  },
  {
    label: "efficiency",
    text: "Efficiency: look for avoidable repeated expensive work, unbounded concurrency, large memory retention, accidental quadratic behavior, and unnecessary I/O. Ignore micro-optimizations.",
    kind: "cleanup",
  },
  {
    label: "altitude",
    text: "Altitude: check whether the implementation solves the requested problem at the right layer and leaves coherent boundaries, names, and user-visible behavior.",
    kind: "cleanup",
  },
]

const VERDICT_SCHEMA = {
  type: "object",
  required: ["verdict", "evidence"],
  properties: {
    verdict: { enum: ["CONFIRMED", "PLAUSIBLE", "REFUTED"] },
    evidence: { type: "string" },
  },
}
const CANDIDATES_SCHEMA = {
  type: "object",
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "summary", "failure_scenario"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          summary: { type: "string" },
          failure_scenario: { type: "string" },
        },
      },
    },
  },
}
const SCOPE_SCHEMA = {
  type: "object",
  required: ["diffCommand", "files", "summary"],
  properties: {
    diffCommand: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    conventions: { type: "string" },
  },
}
const REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "summary", "failure_scenario", "verdict"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          summary: { type: "string" },
          failure_scenario: { type: "string" },
          verdict: { enum: ["CONFIRMED", "PLAUSIBLE"] },
        },
      },
    },
  },
}

phase("Scope")
const scope = await agent(
  "Establish the scope of a code review.\n\n" +
    (TARGET
      ? "Review target / instructions (passed by the user, verbatim): \"" + TARGET + "\". If it names a PR number, branch, ref range, or file path, build the matching git diff command for it; if it is free-form, honor the scope restriction and start from the current branch diff for whatever it does not narrow.\n"
      : "No explicit target — review the current branch. Prefer 'git diff @{upstream}...HEAD' and fall back to 'git diff main...HEAD' or 'git diff HEAD~1'. If there are uncommitted changes also include 'git diff HEAD'.\n") +
    "\n1. Determine exact diff command(s) and run them to confirm they produce a non-empty diff.\n" +
    "2. List changed files.\n" +
    "3. Summarize what changed in one paragraph.\n" +
    "4. Read CLAUDE.md files relevant to changed files and note conventions reviewers should know.\n\n" +
    "Return diffCommand exactly as a reviewer should run it. Structured output only.",
  { label: "scope", phase: "Scope", schema: SCOPE_SCHEMA },
)
if (!scope) {
  return { error: "Scope agent returned no result — cannot establish the review scope." }
}
if (!scope.files || scope.files.length === 0) {
  return { level: LEVEL, target: TARGET || undefined, summary: "No changes found to review.", findings: [], stats: { finders: 0, candidates: 0, verified: 0 } }
}
log(LEVEL + " review: " + scope.files.length + " changed files")

const SCOPE_BLOCK =
  "## Review scope\n" +
  "Diff command: " + scope.diffCommand + "\n" +
  "Changed files (" + scope.files.length + "):\n" +
  scope.files.map(f => "  - " + f).join("\n") + "\n\n" +
  "## What changed\n" + scope.summary + "\n\n" +
  "## Conventions\n" + (scope.conventions || "(none noted)") + "\n" +
  (TARGET ? "\n## User instructions (verbatim)\n" + TARGET + "\nHonor scope restrictions and focus areas above. Do not surface findings the instructions ask to skip.\n" : "")

const FINDER_PROMPT = f =>
  "## Code-review finder — " + f.label + "\n\n" + SCOPE_BLOCK + "\n" +
  "Run the diff command above and review ONLY through this lens:\n\n" +
  f.text + "\n\n" +
  "Surface up to " + P.perAngle + " candidate findings, each with file, line, a one-line summary, and a concrete failure_scenario. " +
  "Pass every candidate with a nameable failure scenario through; an independent verifier judges them next. If nothing qualifies, return an empty list.\n\nStructured output only."

const VERIFIER_PROMPT = c =>
  "## Code-review verifier\n\n" + SCOPE_BLOCK + "\n" +
  "## Candidate finding\n" +
  "File: " + c.file + (c.line != null ? ":" + c.line : "") + "\n" +
  "Summary: " + c.summary + "\n" +
  "Failure scenario: " + c.failure_scenario + "\n\n" +
  "Run the diff command above, read the relevant file(s), and return exactly one verdict:\n" +
  "- CONFIRMED: constructible from code with clear impact.\n" +
  "- PLAUSIBLE: credible bug with concrete mechanism, but not fully proven.\n" +
  "- REFUTED: factually wrong, provably impossible, already handled, or style-only.\n\n" +
  "Structured output only. Evidence must quote or cite the relevant line(s)."

const dedupKey = c => c.file + ":" + (c.line != null ? Math.round(c.line / 5) * 5 : "x:" + String(c.summary || "").toLowerCase().slice(0, 40))
const seen = new Map()
const dupes = []
const budgetDropped = []
let verifySlots = MAX_VERIFY

function verifyCandidate(c) {
  const short = (c.file || "").split("/").pop() || "candidate"
  return agent(VERIFIER_PROMPT(c), { label: "verify:" + short, phase: "Verify", schema: VERDICT_SCHEMA })
    .then(v => (v ? { ...c, verdict: v.verdict, evidence: v.evidence } : null))
}

const FINDERS = CORRECTNESS_ANGLES.slice(0, P.correctnessAngles)
  .map(a => ({ ...a, kind: "correctness" }))
  .concat(CLEANUP_ANGLES.map(a => ({ ...a, kind: "cleanup" })))

phase("Find")
const finderResults = await pipeline(
  FINDERS,
  f => agent(FINDER_PROMPT(f), { label: f.label, phase: "Find", schema: CANDIDATES_SCHEMA }).then(r => {
    if (!r) return { finder: f, candidates: [] }
    log(f.label + ": " + r.candidates.length + " candidates")
    return { finder: f, candidates: r.candidates.slice(0, P.perAngle) }
  }),
  result => {
    const novel = result.candidates.filter(c => {
      const key = dedupKey(c)
      if (seen.has(key)) {
        dupes.push(c)
        return false
      }
      if (verifySlots <= 0) {
        budgetDropped.push(c)
        return false
      }
      seen.set(key, true)
      verifySlots--
      return true
    })
    return parallel(novel.map(c => () => verifyCandidate({ ...c, kind: result.finder.kind })))
  },
)

let verified = finderResults.flat().filter(Boolean)

if (P.sweep) {
  phase("Sweep")
  const knownBlock = verified.length > 0
    ? verified.map(c => "- " + c.file + (c.line != null ? ":" + c.line : "") + " — " + c.summary).join("\n")
    : "(none)"
  const sweep = await agent(
    "## Code-review sweep — gaps only\n\n" + SCOPE_BLOCK + "\n" +
      "## Already-found candidates (do NOT re-derive or re-confirm these)\n" + knownBlock + "\n\n" +
      "Re-read the diff and enclosing functions looking ONLY for defects not already listed. Focus on moved guards, anchors, setup/teardown asymmetry, config default flips, second-tier footguns, and edge cases first-pass finders miss.\n\n" +
      "Surface up to " + SWEEP_MAX + " additional candidates. If nothing new, return an empty list — do not pad.\n\nStructured output only.",
    { label: "sweep", phase: "Sweep", schema: CANDIDATES_SCHEMA },
  )
  if (sweep && sweep.candidates.length > 0) {
    const novel = sweep.candidates.slice(0, SWEEP_MAX).filter(c => !seen.has(dedupKey(c)))
    log("sweep: " + novel.length + " new candidates")
    const sweepVerified = await parallel(novel.map(c => () => verifyCandidate({ ...c, kind: "correctness" })))
    verified = verified.concat(sweepVerified.filter(Boolean))
  }
}

const surviving = verified.filter(c => c.verdict !== "REFUTED")
const refuted = verified.filter(c => c.verdict === "REFUTED")
log("Verify done: " + verified.length + " verified → " + surviving.length + " kept, " + refuted.length + " refuted")

const stats = {
  level: LEVEL,
  finders: FINDERS.length,
  candidates: seen.size + dupes.length + budgetDropped.length,
  verified: verified.length,
  refuted: refuted.length,
  dupes: dupes.length,
  budgetDropped: budgetDropped.length,
}

if (surviving.length === 0) {
  return {
    level: LEVEL,
    target: TARGET || undefined,
    summary: "No findings survived verification.",
    findings: [],
    refuted: refuted.map(c => ({ file: c.file, line: c.line, summary: c.summary })),
    stats,
  }
}

phase("Synthesize")
const rank = c => (c.kind === "cleanup" ? 2 : 0) + (c.verdict === "PLAUSIBLE" ? 1 : 0)
const ranked = surviving.slice().sort((a, b) => rank(a) - rank(b))
const block = ranked.map((c, i) =>
  "### [" + i + "] " + c.file + (c.line != null ? ":" + c.line : "") + " (" + c.verdict + (c.kind === "cleanup" ? ", cleanup" : "") + ")\n" +
  c.summary + "\nFailure scenario: " + c.failure_scenario + "\nVerifier evidence: " + c.evidence + "\n"
).join("\n")

const report = await agent(
  "## Synthesis: final code-review report\n\n" +
    ranked.length + " findings survived independent verification (" + LEVEL + "-effort review).\n\n" + block + "\n" +
    "## Instructions\n" +
    "1. Merge findings that describe the same defect.\n" +
    "2. Rank most-severe first. Correctness bugs always outrank cleanup findings.\n" +
    "3. Keep at most " + P.maxFindings + " findings; drop the least severe beyond the cap.\n" +
    "4. Write a 2-3 sentence summary of the review.\n\nStructured output only.",
  { label: "synthesize", phase: "Synthesize", schema: REPORT_SCHEMA },
)

const findings = report
  ? report.findings.slice(0, P.maxFindings)
  : ranked.slice(0, P.maxFindings).map(c => ({
      file: c.file,
      line: c.line,
      summary: c.summary,
      failure_scenario: c.failure_scenario,
      verdict: c.verdict,
    }))

return {
  level: LEVEL,
  target: TARGET || undefined,
  summary: report ? report.summary : "Synthesis step was skipped or failed — returning verified findings unmerged.",
  findings,
  refuted: refuted.map(c => ({ file: c.file, line: c.line, summary: c.summary })),
  stats: { ...stats, reported: findings.length },
}`

const BUNDLED_WORKFLOWS: WorkflowSpec[] = [
  {
    name: 'code-review',
    description:
      'Workflow-backed code review — one finder agent per review angle, an independent verifier for every candidate, then a ranked, capped findings report.',
    meta: {
      name: 'code-review',
      description:
        'Workflow-backed code review — one finder agent per review angle, an independent verifier for every candidate, then a ranked, capped findings report.',
      whenToUse:
        'Review current branch changes at high, xhigh, or max effort. Pass args as "<level> [target]" — level is high, xhigh, or max; target is an optional PR number, branch, ref range, path, or free-form review instructions.',
      phases: [
        { title: 'Scope', detail: 'Pin the diff command, changed files, and conventions' },
        { title: 'Find', detail: 'One finder agent per review angle, streaming into verify' },
        { title: 'Verify', detail: 'One independent verifier per candidate — CONFIRMED / PLAUSIBLE / REFUTED' },
        { title: 'Sweep', detail: 'Fresh finder hunting only for gaps at xhigh/max' },
        { title: 'Synthesize', detail: 'Merge duplicates, rank, cap the report' },
      ],
    },
    runScriptSnapshot: CODE_REVIEW_SCRIPT,
    defaults: {
      maxConcurrency: 16,
      maxAgents: 50,
      maxRetries: 0,
      permissionMode: 'plan',
    },
    phases: [
      {
        id: 'scope',
        displayName: 'Scope',
        description: 'Pin the diff command, changed files, and conventions.',
        prompt:
          'Establish the exact code-review scope from workflow args, identify the diff command, changed files, summary, and relevant conventions. Structured output only.',
      },
      {
        id: 'find',
        displayName: 'Find',
        description: 'Run independent correctness and cleanup finder angles.',
        prompt:
          'Run independent code-review finder angles over the scoped diff. Surface concrete candidate findings with file, line, summary, and failure scenario. Structured output only.',
        dependsOn: ['scope'],
        fanout: 9,
        concurrency: 9,
        review: 'adversarial',
      },
      {
        id: 'verify',
        displayName: 'Verify',
        description: 'Independently verify candidate findings.',
        prompt:
          'Verify each candidate finding as CONFIRMED, PLAUSIBLE, or REFUTED using direct code evidence. Drop unsupported or style-only findings.',
        dependsOn: ['find'],
        fanout: 25,
        concurrency: 16,
        review: 'cross-check',
      },
      {
        id: 'sweep',
        displayName: 'Sweep',
        description: 'Run a fresh gap finder for xhigh/max effort.',
        prompt:
          'For xhigh/max effort, run one fresh finder looking only for gaps not already listed, then verify novel candidates. For high effort this phase may produce no additional findings.',
        dependsOn: ['verify'],
        fanout: 9,
        concurrency: 9,
        review: 'adversarial',
      },
      {
        id: 'synthesize',
        displayName: 'Synthesize',
        description: 'Merge duplicates, rank, cap the final report.',
        prompt:
          'Synthesize verified findings into a ranked, capped code-review report. Merge duplicates, correctness bugs outrank cleanup findings, and exclude refuted candidates.',
        dependsOn: ['sweep'],
        review: 'synthesis',
      },
    ],
  },
  {
    name: 'deep-research',
    description:
      'Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.',
    meta: {
      name: 'deep-research',
      description:
        'Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.',
      whenToUse:
        'When the user wants a deep, multi-source, fact-checked research report on any topic.',
      phases: [
        { title: 'Scope', detail: 'Decompose question into search angles' },
        { title: 'Search', detail: 'Fan-out web searches for scoped angles' },
        { title: 'Fetch', detail: 'Deduplicate URLs, fetch sources, extract claims' },
        { title: 'Verify', detail: 'Adversarial 3-vote claim verification' },
        { title: 'Synthesize', detail: 'Produce cited report with stats and caveats' },
      ],
    },
    runScriptSnapshot: `const VOTES_PER_CLAIM = 3
const REFUTATIONS_REQUIRED = 2
const MAX_FETCH = 15
const MAX_VERIFY_CLAIMS = 25

const REPORT_SCHEMA = {
  executiveSummary: 'string',
  findings: 'array',
  caveats: 'array',
  openQuestions: 'array',
  refutedClaims: 'array',
  stats: { sourcesFetched, claimsVerified, claimsRefuted, claimsUsed },
}

workflow('deep-research')
phase('Scope')
phase('Search')
phase('Fetch')
phase('Verify')
phase('Synthesize')`,
    defaults: {
      maxConcurrency: 6,
      maxAgents: 40,
      maxRetries: 1,
      permissionMode: 'plan',
    },
    phases: [
      {
        id: 'scope',
        description: 'Decompose question (from args) into 5 search angles.',
        prompt:
          'Decompose this research question into complementary search angles. Generate 5 distinct web search queries that together cover the question from different angles. Pick angles that suit the question domain, such as broad/primary, academic/technical, recent news, contrarian/skeptical, and practitioner/implementation. Make queries specific enough to surface high-signal results. Avoid redundancy. Return the question verbatim or lightly normalized, a 1-2 sentence decomposition strategy, and the angles. Structured output only.',
      },
      {
        id: 'search',
        description: '5 parallel WebSearch agents, one per angle.',
        prompt:
          'Use WebSearch for one scoped angle and return the top 4-6 most relevant results. Rank by relevance to the original question, not just the search query. Skip obvious SEO spam and content farms. Include URL, title, snippet, and relevance high/medium/low with a short snippet capturing why each result is relevant. Structured output only.',
        dependsOn: ['scope'],
        fanout: 5,
        concurrency: 5,
      },
      {
        id: 'fetch',
        description: 'URL-dedup, fetch top 15 sources, extract falsifiable claims.',
        prompt:
          'URL-deduplicate search results by normalized host and path, keep a running top-15 fetch budget, prefer high relevance, then use WebFetch to retrieve each novel source. Assess source quality as primary, secondary, blog, forum, or unreliable. Extract 2-5 falsifiable claims per source that bear on the research question, each with a direct quote and importance central/supporting/tangential. If the fetch fails or the page is irrelevant or paywalled, return claims: [] and sourceQuality: "unreliable". Structured output only.',
        dependsOn: ['search'],
        fanout: 15,
        concurrency: 6,
        review: 'cross-check',
      },
      {
        id: 'verify',
        description: '3-vote adversarial verification per claim (need 2/3 refutes to kill).',
        prompt:
          'Run 3-vote adversarial verification over the top 25 candidate claims. Be skeptical and try to refute each claim. Check whether the quote supports it, whether credible sources contradict or qualify it, whether the source quality is sufficient, whether it is outdated, and whether it is marketing fluff, press release cherry-picking, or forum speculation. Treat skipped or failed votes as abstentions. A claim survives only with at least 2 valid votes and fewer than 2 refutations. Default to refuted=true if uncertain. Evidence must be specific.',
        dependsOn: ['fetch'],
        fanout: 3,
        concurrency: 3,
        review: 'adversarial',
      },
      {
        id: 'synthesize',
        description: 'Merge semantic dupes, rank by confidence, cite sources.',
        prompt:
          'Synthesize a cited research report from claims that survived 3-vote adversarial verification. Merge semantic duplicates and combine sources. Group related claims into findings that directly address the research question. Assign confidence: high for multiple primary sources or unanimous votes, medium for secondary sources or split votes, low for single-source or blog-quality evidence. Write a 3-5 sentence executive summary, list caveats and time-sensitivity, include 2-4 open questions, and include refuted claims for transparency. If the Synthesis step was skipped or failed, salvage verified claims raw rather than discarding the run.',
        dependsOn: ['verify'],
        review: 'synthesis',
      },
    ],
  },
]

export function initBundledWorkflows(): void {}

export function getBundledWorkflowSpecs(): WorkflowSpec[] {
  return BUNDLED_WORKFLOWS.map(workflow => structuredClone(workflow))
}
