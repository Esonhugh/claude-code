import type { WorkflowSpec } from '../workflowSpec.js'

const BUNDLED_WORKFLOWS: WorkflowSpec[] = [
  {
    name: 'bughunt-lite',
    description:
      'Bounded bug sweep of the current branch with independent finders, adversarial verification, and concise synthesis.',
    defaults: {
      maxConcurrency: 4,
      maxAgents: 8,
      maxRetries: 0,
      permissionMode: 'plan',
    },
    phases: [
      {
        id: 'scope',
        description: 'Identify the diff, changed files, test surface, and risk areas.',
        prompt:
          'Inspect the current branch and identify changed files, nearby tests, risk areas, and likely bug classes. Do not edit files.',
      },
      {
        id: 'finders',
        description: 'Run a bounded pool of independent bug finders.',
        prompt:
          'Review the scoped changes for concrete bugs. Report only reproducible issues with file paths, evidence, and minimal failing scenario. Avoid style-only findings.',
        dependsOn: ['scope'],
        fanout: 3,
        concurrency: 3,
        review: 'adversarial',
      },
      {
        id: 'verify',
        description: 'Adversarially verify candidate findings.',
        prompt:
          'Verify candidate bug findings from the finder phase. Reject unsupported findings and keep only issues backed by code evidence.',
        dependsOn: ['finders'],
        fanout: 2,
        concurrency: 2,
        review: 'cross-check',
      },
      {
        id: 'synthesis',
        description: 'Summarize verified bugs and suggested next fixes.',
        prompt:
          'Synthesize only verified bugs. Include severity, evidence, exact files, and minimal next fix. Explicitly list rejected findings if useful.',
        dependsOn: ['verify'],
        review: 'synthesis',
      },
    ],
  },
  {
    name: 'review-branch',
    description:
      'Thoroughly review the current branch for bugs, simplicity, architecture, dead code, best practices, and consistency.',
    defaults: {
      maxConcurrency: 4,
      maxAgents: 10,
      permissionMode: 'plan',
    },
    phases: [
      {
        id: 'scope',
        description: 'Discover branch diff, base branch, changed files, and conventions.',
        prompt:
          'Inspect the current branch against its base. Identify changed files, touched subsystems, conventions, and tests that should matter. Do not edit files.',
      },
      {
        id: 'reviewers',
        description: 'Run independent review perspectives.',
        prompt:
          'Review the scoped branch from one perspective: correctness, simplicity, architecture, dead code, best practices, or pattern consistency. Return concrete findings only.',
        dependsOn: ['scope'],
        fanout: 4,
        concurrency: 4,
        review: 'cross-check',
      },
      {
        id: 'refuters',
        description: 'Challenge each candidate finding before reporting.',
        prompt:
          'Adversarially refute candidate review findings. Keep only findings with direct evidence and clear impact.',
        dependsOn: ['reviewers'],
        fanout: 2,
        concurrency: 2,
        review: 'adversarial',
      },
      {
        id: 'final-review',
        description: 'Produce the final verified branch review.',
        prompt:
          'Write the final branch review with verified findings, evidence, severity, and suggested fixes. Do not include unverified concerns.',
        dependsOn: ['refuters'],
        review: 'synthesis',
      },
    ],
  },
  {
    name: 'plan-hunter',
    description:
      'Generate independent plans, judge them from multiple angles, vote on the winner, and synthesize a stronger final plan.',
    defaults: {
      maxConcurrency: 4,
      maxAgents: 10,
      permissionMode: 'plan',
    },
    phases: [
      {
        id: 'draft-plans',
        description: 'Generate independent draft plans from different optimization angles.',
        prompt:
          'Create one implementation plan for the requested idea. Use one strong perspective: MVP-first, risk-first, dependency-first, or user-first. Include assumptions and verification gates.',
        fanout: 4,
        concurrency: 4,
      },
      {
        id: 'judges',
        description: 'Score the draft plans independently.',
        prompt:
          'Judge the draft plans for correctness, feasibility, risk, simplicity, and verification quality. Pick a winner and note reusable ideas from runners-up.',
        dependsOn: ['draft-plans'],
        fanout: 4,
        concurrency: 4,
        review: 'cross-check',
      },
      {
        id: 'final-plan',
        description: 'Synthesize a final plan from the voted winner and best runner-up ideas.',
        prompt:
          'Synthesize the final implementation plan. Preserve the winner’s core structure and graft in only the strongest verified ideas from runners-up.',
        dependsOn: ['judges'],
        review: 'synthesis',
      },
    ],
  },
  {
    name: 'investigate',
    description:
      'Root-cause investigation workflow with evidence gathering, competing hypotheses, adversarial refutation, and a final report.',
    defaults: {
      maxConcurrency: 4,
      maxAgents: 10,
      permissionMode: 'plan',
    },
    phases: [
      {
        id: 'evidence',
        description: 'Gather observable evidence and constraints.',
        prompt:
          'Gather evidence for the reported problem: symptoms, logs, code paths, recent changes, tests, and constraints. Do not fix yet.',
      },
      {
        id: 'hypotheses',
        description: 'Generate competing root-cause hypotheses.',
        prompt:
          'Generate a competing root-cause hypothesis from the evidence. Include predictions that would prove or disprove it.',
        dependsOn: ['evidence'],
        fanout: 4,
        concurrency: 4,
      },
      {
        id: 'refute',
        description: 'Adversarially refute weak hypotheses.',
        prompt:
          'Try to disprove each hypothesis using evidence. Identify the best-supported root cause and reject weak explanations.',
        dependsOn: ['hypotheses'],
        fanout: 2,
        concurrency: 2,
        review: 'adversarial',
      },
      {
        id: 'report',
        description: 'Write the root-cause report and suggested fix.',
        prompt:
          'Write a root-cause report with evidence, rejected hypotheses, confidence, and the smallest suggested fix or next experiment.',
        dependsOn: ['refute'],
        review: 'synthesis',
      },
    ],
  },
  {
    name: 'bugfix',
    description:
      'Reproduce-first bug fixer that writes a failing repro, identifies root cause, proposes a minimal fix, and locks in a regression test plan.',
    defaults: {
      maxConcurrency: 3,
      maxAgents: 8,
      maxRetries: 1,
      permissionMode: 'acceptEdits',
    },
    phases: [
      {
        id: 'reproduce',
        description: 'Create or identify the failing reproduction.',
        prompt:
          'Reproduce the reported bug first. Prefer an automated failing test or a precise manual repro. Do not implement the fix until the failure is understood.',
      },
      {
        id: 'root-cause',
        description: 'Find the smallest root cause.',
        prompt:
          'Trace the failing repro to the smallest root cause. Identify the responsible code path and why existing tests missed it.',
        dependsOn: ['reproduce'],
        review: 'cross-check',
      },
      {
        id: 'fix',
        description: 'Apply the minimal fix and regression coverage.',
        prompt:
          'Apply the minimal fix and convert the repro into regression coverage. Run the narrow verification needed for the bug.',
        dependsOn: ['root-cause'],
        permissionMode: 'acceptEdits',
      },
      {
        id: 'verify',
        description: 'Verify the fix and summarize evidence.',
        prompt:
          'Verify the regression test and relevant suite. Summarize the bug, fix, evidence, and any remaining risk.',
        dependsOn: ['fix'],
        review: 'synthesis',
      },
    ],
  },
  {
    name: 'docs',
    description:
      'Documentation generator that discovers feature surface and conventions, drafts docs, and verifies examples and links.',
    defaults: {
      maxConcurrency: 3,
      maxAgents: 8,
      maxRetries: 1,
      permissionMode: 'acceptEdits',
    },
    phases: [
      {
        id: 'discover',
        description: 'Discover code surface and documentation conventions.',
        prompt:
          'Discover the relevant feature/API/module surface and existing documentation conventions. Identify target audience and missing docs.',
      },
      {
        id: 'outline',
        description: 'Create a documentation outline.',
        prompt:
          'Create a concise documentation outline with sections, examples, and verification steps. Match existing project style.',
        dependsOn: ['discover'],
        review: 'cross-check',
      },
      {
        id: 'write-docs',
        description: 'Write or update documentation.',
        prompt:
          'Write or update the documentation following the verified outline. Include accurate examples and avoid unsupported claims.',
        dependsOn: ['outline'],
        permissionMode: 'acceptEdits',
      },
      {
        id: 'verify-docs',
        description: 'Verify examples, links, and consistency.',
        prompt:
          'Verify code examples, links, and consistency with the code. Report any commands run and remaining caveats.',
        dependsOn: ['write-docs'],
        review: 'synthesis',
      },
    ],
  },
  {
    name: 'deep-research',
    description:
      'Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.',
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
  {
    name: 'bughunt',
    description:
      'High-precision multi-agent bug sweep with broad finder pool, adversarial verification votes, and final synthesis.',
    defaults: {
      maxConcurrency: 8,
      maxAgents: 24,
      permissionMode: 'plan',
    },
    phases: [
      {
        id: 'scope',
        description: 'Discover review scope, changed files, tests, and high-risk areas.',
        prompt:
          'Scope the current branch for a high-precision bug hunt. Identify diff base, changed files, critical paths, existing tests, and risk taxonomy.',
      },
      {
        id: 'rapid-finders',
        description: 'Run rapid independent bug finders.',
        prompt:
          'Find concrete bugs quickly in the scoped branch. Report only issues with evidence, likely impact, and reproduction or failing-test idea.',
        dependsOn: ['scope'],
        fanout: 5,
        concurrency: 5,
        review: 'adversarial',
      },
      {
        id: 'deep-finders',
        description: 'Run deeper targeted bug finders on risky areas.',
        prompt:
          'Perform a deeper targeted bug hunt on the riskiest areas from scope and rapid findings. Look for edge cases, races, type holes, data loss, and security-sensitive regressions.',
        dependsOn: ['scope'],
        fanout: 3,
        concurrency: 3,
        review: 'adversarial',
      },
      {
        id: 'vote-verify',
        description: 'Vote on and verify candidate findings.',
        prompt:
          'Vote on candidate findings from rapid and deep finders. Keep only findings that survive adversarial verification and have direct evidence.',
        dependsOn: ['rapid-finders', 'deep-finders'],
        fanout: 5,
        concurrency: 5,
        review: 'cross-check',
      },
      {
        id: 'synthesis',
        description: 'Produce final high-confidence bug report.',
        prompt:
          'Synthesize verified bug findings with severity, evidence, affected files, reproduction ideas, and recommended fixes. Exclude unverified concerns.',
        dependsOn: ['vote-verify'],
        review: 'synthesis',
      },
    ],
  },
  {
    name: 'dashboard',
    description:
      'Dashboard generator that discovers data sources and conventions, designs panels, implements the dashboard, and verifies queries/rendering.',
    defaults: {
      maxConcurrency: 4,
      maxAgents: 12,
      maxRetries: 1,
      permissionMode: 'acceptEdits',
    },
    phases: [
      {
        id: 'discover',
        description: 'Discover dashboard conventions and available data sources.',
        prompt:
          'Discover existing dashboard, metrics, charting, and data-fetching conventions. Identify available data sources, query patterns, and rendering constraints.',
      },
      {
        id: 'design',
        description: 'Design panel layout and data contracts.',
        prompt:
          'Design a dashboard layout with panels, data contracts, loading/error states, and validation strategy. Match existing UI and query conventions.',
        dependsOn: ['discover'],
        review: 'cross-check',
      },
      {
        id: 'implement',
        description: 'Implement the dashboard or metrics view.',
        prompt:
          'Implement the dashboard according to the verified design. Keep changes focused, follow existing components, and avoid unrelated refactors.',
        dependsOn: ['design'],
        permissionMode: 'acceptEdits',
      },
      {
        id: 'verify',
        description: 'Verify queries, rendering, accessibility, and regressions.',
        prompt:
          'Verify dashboard queries, rendering behavior, accessibility basics, and relevant tests. Report exact verification evidence and remaining caveats.',
        dependsOn: ['implement'],
        fanout: 2,
        concurrency: 2,
        review: 'adversarial',
      },
      {
        id: 'handoff',
        description: 'Summarize dashboard implementation and PR-ready notes.',
        prompt:
          'Summarize dashboard changes, screenshots or render evidence if available, test results, and PR-ready notes. Do not create a PR unless explicitly requested.',
        dependsOn: ['verify'],
        review: 'synthesis',
      },
    ],
  },
  {
    name: 'autopilot',
    description:
      'End-to-end task runner with adversarial planning, implementation, bughunt-lite review, completeness check, repair, and PR-ready handoff.',
    defaults: {
      maxConcurrency: 6,
      maxAgents: 24,
      maxRetries: 2,
      permissionMode: 'acceptEdits',
    },
    phases: [
      {
        id: 'scope',
        description: 'Scope the task and identify constraints.',
        prompt:
          'Scope the requested task from workflow args. Identify requirements, non-goals, risks, verification gates, and files likely to change.',
        permissionMode: 'plan',
      },
      {
        id: 'plan-critics',
        description: 'Generate adversarial critiques of the initial plan.',
        prompt:
          'Critique the scoped plan from one angle: correctness, simplicity, integration risk, test strategy, or user impact. Propose concrete plan adjustments.',
        dependsOn: ['scope'],
        fanout: 5,
        concurrency: 5,
        permissionMode: 'plan',
        review: 'adversarial',
      },
      {
        id: 'hardened-plan',
        description: 'Synthesize the hardened implementation plan.',
        prompt:
          'Synthesize a hardened implementation plan from scope and critic feedback. Keep it minimal, testable, and explicit about verification.',
        dependsOn: ['plan-critics'],
        permissionMode: 'plan',
        review: 'synthesis',
      },
      {
        id: 'implement',
        description: 'Implement the hardened plan.',
        prompt:
          'Implement the hardened plan. Follow existing project conventions, keep changes focused, and run the narrow verification described by the plan.',
        dependsOn: ['hardened-plan'],
        permissionMode: 'acceptEdits',
      },
      {
        id: 'bughunt-lite',
        description: 'Run bounded bug sweep on the implementation.',
        prompt:
          'Run a bounded bughunt-lite review of the implementation. Find concrete correctness, integration, or regression issues only.',
        dependsOn: ['implement'],
        fanout: 3,
        concurrency: 3,
        permissionMode: 'plan',
        review: 'adversarial',
      },
      {
        id: 'completeness',
        description: 'Check feature completeness against requirements.',
        prompt:
          'Check whether the implementation satisfies the scoped requirements and verification gates. Identify missing requirements or overbuilt changes.',
        dependsOn: ['implement'],
        fanout: 2,
        concurrency: 2,
        permissionMode: 'plan',
        review: 'cross-check',
      },
      {
        id: 'repair',
        description: 'Repair verified issues only.',
        prompt:
          'Fix only verified bughunt or completeness issues. Re-run targeted verification and avoid unrelated cleanup.',
        dependsOn: ['bughunt-lite', 'completeness'],
        permissionMode: 'acceptEdits',
      },
      {
        id: 'handoff',
        description: 'Prepare PR-ready handoff without creating external PRs.',
        prompt:
          'Prepare a PR-ready summary with changed files, verification evidence, known risks, and suggested PR title/body. Do not create or push a PR unless explicitly requested.',
        dependsOn: ['repair'],
        permissionMode: 'plan',
        review: 'synthesis',
      },
    ],
  },
]

export function initBundledWorkflows(): void {}

export function getBundledWorkflowSpecs(): WorkflowSpec[] {
  return BUNDLED_WORKFLOWS.map(workflow => structuredClone(workflow))
}
