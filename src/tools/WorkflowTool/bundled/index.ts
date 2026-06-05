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
      'Deep research workflow with scoped search angles, source extraction, adversarial claim verification, and cited synthesis.',
    defaults: {
      maxConcurrency: 6,
      maxAgents: 18,
      maxRetries: 1,
      permissionMode: 'plan',
    },
    phases: [
      {
        id: 'scope',
        description: 'Decompose the research question into complementary angles.',
        prompt:
          'Decompose the research question from workflow args into complementary search angles. Define success criteria, likely source types, and claims that need verification.',
      },
      {
        id: 'search',
        description: 'Search independently from multiple angles.',
        prompt:
          'Research one scoped angle using available tools. Return source URLs or local references, extracted facts, and uncertainty. Prefer primary sources.',
        dependsOn: ['scope'],
        fanout: 4,
        concurrency: 4,
      },
      {
        id: 'dedupe-extract',
        description: 'Deduplicate sources and extract candidate claims.',
        prompt:
          'Deduplicate overlapping sources from the search phase. Extract atomic candidate claims with source support and note conflicts.',
        dependsOn: ['search'],
        review: 'cross-check',
      },
      {
        id: 'verify-claims',
        description: 'Adversarially verify or refute candidate claims.',
        prompt:
          'Verify candidate claims against cited evidence. Refute weak claims, flag unsupported statements, and keep only claims with adequate support.',
        dependsOn: ['dedupe-extract'],
        fanout: 3,
        concurrency: 3,
        review: 'adversarial',
      },
      {
        id: 'synthesis',
        description: 'Write the final cited research report.',
        prompt:
          'Write a concise research report using only verified claims. Include citations/source references, disputed claims, and confidence notes.',
        dependsOn: ['verify-claims'],
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
