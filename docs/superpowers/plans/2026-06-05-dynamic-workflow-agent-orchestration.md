# Dynamic Workflow and Agent Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a staged secondary-development foundation for Claude Code dynamic workflows and agent orchestration, starting with architecture documentation, validated workflow specs, dry-run inspection, and workflow-backed prompt commands before any full runtime execution.

**Architecture:** Treat dynamic workflows as a coordination layer above existing agent, task, hook, permission, and worktree primitives. The completed dry-run layer makes workflow behavior reviewable before agents execute it. Later phases can extend `LocalWorkflowTask` into an executable runner without bypassing existing permission boundaries.

**Tech Stack:** TypeScript, Node.js ESM, Claude Code command/tool/task architecture, feature-gated Bun bundle imports, Markdown docs, JSON declarative workflow specs, esbuild-based workflow test scripts.

---

## File Structure

- Create: `docs/dynamic-workflow-agent-orchestration.md`
  - Human-facing architecture document for Claude Code dynamic workflows, subagents, agent teams, skills, hooks, permissions, and worktrees.
  - Includes official mental model, local repository map, and staged secondary-development roadmap.
- Modify: `docs/README.md`
  - Add an index entry pointing to the architecture document.
- Create: `docs/superpowers/specs/2026-06-05-dynamic-workflow-agent-orchestration-design.md`
  - Design spec that records the agreed scope and phased strategy.
- Create: `docs/superpowers/plans/2026-06-05-dynamic-workflow-agent-orchestration.md`
  - This implementation plan.
- Created: `src/tools/WorkflowTool/workflowSpec.ts`
  - Types for declarative workflow specs and normalized dry-run plans.
- Created: `src/tools/WorkflowTool/validateWorkflowSpec.ts`
  - Pure validation for phase IDs, dependencies, cycles, concurrency, fan-out, review modes, permission modes, and agent limits.
- Created: `src/tools/WorkflowTool/formatWorkflowDryRun.ts`
  - Pure formatter for dry-run execution plans.
- Created: `src/tools/WorkflowTool/workflowDiscovery.ts`
  - Root-aware discovery for specs in `docs/workflows/` and `.claude/workflows/`.
- Modified: `src/tools/WorkflowTool/WorkflowTool.ts`
  - Read-only workflow inspection tool with `list`, `show`, and `dry-run` actions.
- Modified: `src/tools/WorkflowTool/createWorkflowCommand.ts`
  - Discover workflow specs and return workflow-backed prompt commands.
- Created: `src/commands/workflows/workflows.ts`
  - Local `/workflows` command implementation for list/show/dry-run.
- Future modify: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`
  - Extend task state only when execution runtime begins.

---

### Task 1: Write the architecture document

**Files:**
- Create: `docs/dynamic-workflow-agent-orchestration.md`

- [ ] **Step 1: Create the architecture document**

Create `docs/dynamic-workflow-agent-orchestration.md` with this content:

```markdown
# Dynamic Workflow and Agent Orchestration

## Purpose

This document explains how Claude Code dynamic workflows relate to subagents, agent teams, skills, hooks, permissions, and worktrees, then maps those concepts onto this recovered codebase for secondary development.

Dynamic workflows should not be treated as just another agent type. They are an orchestration layer: a script or validated spec owns phase ordering, fan-out, cross-checking, retry policy, and synthesis while agents perform the actual work through normal tool permissions.

## Primitive model

| Primitive | Coordinator | State location | Best use |
| --- | --- | --- | --- |
| Skill | Current Claude session following loaded instructions | Main session context while loaded | Reusable procedure, checklist, or domain knowledge |
| Subagent | Current Claude session | Subagent context, summarized back to caller | Focused research, review, or implementation that would flood main context |
| Agent view | User | Separate background sessions | Independent tasks the user wants to monitor manually |
| Agent team | Team lead Claude session | Shared task list and mailbox | Multi-session collaboration where workers need to coordinate |
| Dynamic workflow | Workflow script/runtime | Script variables and workflow task state | Large repeatable fan-out, cross-checking, audits, migrations, or multi-angle planning |
| Worktree | User or orchestration layer | Separate git checkout | Filesystem isolation for parallel edits |
| Hook | Claude Code runtime | Settings and hook process result | Deterministic policy, validation, notification, and guardrails |
| Permission | Claude Code runtime | Permission settings and prompts | Safety boundary for tool use |

## Official design intent

Dynamic workflows exist to move orchestration out of turn-by-turn Claude judgment and into a readable, repeatable script. That matters when a task requires more workers than a single conversation can coordinate, or when intermediate findings need to be cross-checked before they are trusted.

The important design goals are:

1. Keep intermediate results out of the main conversation context.
2. Make the orchestration itself reviewable and reusable.
3. Support bounded fan-out across many agents.
4. Encode quality patterns such as adversarial review and synthesis.
5. Preserve normal tool permission boundaries.

## Local repository map

The recovered repository already contains agent and task foundations:

- `src/commands.ts` gates workflow commands behind `WORKFLOW_SCRIPTS`.
- `src/tools.ts` gates `WorkflowTool` and bundled workflow initialization behind `WORKFLOW_SCRIPTS`.
- `src/tools/AgentTool/AgentTool.tsx` is the existing worker-spawn primitive.
- `src/tools/TeamCreateTool/TeamCreateTool.ts`, `src/tools/TeamDeleteTool/TeamDeleteTool.ts`, and `src/tools/SendMessageTool/SendMessageTool.ts` provide team and mailbox primitives.
- `src/tools/TaskCreateTool`, `TaskGetTool`, `TaskUpdateTool`, and `TaskListTool` provide shared task coordination.
- `src/tasks.ts` conditionally registers `LocalWorkflowTask`.
- `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` is currently a recovered workflow task stub.

Current workflow surface:

- `src/tools/WorkflowTool/WorkflowTool.ts` provides read-only workflow inspection actions.
- `src/tools/WorkflowTool/createWorkflowCommand.ts` returns workflow-backed prompt commands for valid specs.
- `src/commands/workflows/workflows.ts` implements `/workflows list`, `/workflows show`, and `/workflows dry-run`.
- `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` has no runner state beyond minimal metadata and kill handling.
- `skipWorkflowAgent()` and `retryWorkflowAgent()` are currently empty recovered stubs.

## Secondary-development roadmap

### Phase 0: Documentation and boundaries

Document the primitive model, local extension points, and non-goals. Do not implement a runtime yet.

### Phase 1: Declarative workflow spec

Define a reviewable workflow spec with phases, dependencies, fan-out, concurrency, review mode, and output expectations.

### Phase 2: Dry-run command

Discover and validate workflow specs, then print the execution graph without spawning agents.

### Phase 3: Minimal execution runtime

Map workflow phases to existing agent-spawn primitives. Store progress in `LocalWorkflowTaskState`. Enforce max concurrency and max agent count.

### Phase 4: Cross-check and synthesis

Add review phases that compare independent findings and synthesize only verified claims.

### Phase 5: UI and recovery

Add workflow list, progress details, pause/resume/stop, skip, retry, saved commands, and cost visibility.

## Implementation rule

Workflow execution must not directly call shell or filesystem operations. Workflow phases should spawn agents, and those agents must use normal Claude Code tools under existing permission and hook rules.
```

- [ ] **Step 2: Verify the document has no unfinished-marker text**

Run:

```bash
grep -nE 'TB[D]|TO[D]O|implement[[:space:]]+later|fill[[:space:]]+in|placeholde[r]' docs/dynamic-workflow-agent-orchestration.md || true
```

Expected: no output.

- [ ] **Step 3: Check Markdown whitespace**

Run:

```bash
git diff --check -- docs/dynamic-workflow-agent-orchestration.md
```

Expected: no output.

---

### Task 2: Index the architecture document

**Files:**
- Modify: `docs/README.md`

- [ ] **Step 1: Add the document to the docs index**

Open `docs/README.md` and add this bullet in the most relevant documentation list:

```markdown
- [Dynamic Workflow and Agent Orchestration](./dynamic-workflow-agent-orchestration.md) — explains Claude Code workflow, subagent, agent team, skill, hook, permission, and worktree primitives for secondary development.
```

If `docs/README.md` has no existing list, add this section near the top after the title:

```markdown
## Architecture and secondary development

- [Dynamic Workflow and Agent Orchestration](./dynamic-workflow-agent-orchestration.md) — explains Claude Code workflow, subagent, agent team, skill, hook, permission, and worktree primitives for secondary development.
```

- [ ] **Step 2: Verify the link target exists**

Run:

```bash
test -f docs/dynamic-workflow-agent-orchestration.md
```

Expected: command exits 0.

- [ ] **Step 3: Check docs whitespace**

Run:

```bash
git diff --check -- docs/README.md docs/dynamic-workflow-agent-orchestration.md
```

Expected: no output.

---

### Task 3: Define workflow spec types

**Files:**
- Create: `src/tools/WorkflowTool/workflowSpec.ts`

- [ ] **Step 1: Write type definitions**

Create `src/tools/WorkflowTool/workflowSpec.ts` with this content:

```ts
export type WorkflowReviewMode = 'none' | 'cross-check' | 'adversarial' | 'synthesis'

export type WorkflowPermissionMode = 'default' | 'acceptEdits' | 'plan'

export type WorkflowSpec = {
  name: string
  description: string
  input?: WorkflowInputSpec
  defaults?: WorkflowDefaults
  phases: WorkflowPhaseSpec[]
}

export type WorkflowInputSpec = {
  description?: string
  required?: string[]
}

export type WorkflowDefaults = {
  maxConcurrency?: number
  maxAgents?: number
  permissionMode?: WorkflowPermissionMode
}

export type WorkflowPhaseSpec = {
  id: string
  description: string
  prompt: string
  agentType?: string
  model?: string
  dependsOn?: string[]
  fanout?: number
  concurrency?: number
  review?: WorkflowReviewMode
  output?: WorkflowOutputSpec
}

export type WorkflowOutputSpec = {
  description?: string
  format?: 'summary' | 'findings' | 'patch' | 'report'
}

export type WorkflowDryRunPhase = {
  id: string
  description: string
  dependsOn: string[]
  fanout: number
  concurrency: number
  review: WorkflowReviewMode
  agentType?: string
  model?: string
}

export type WorkflowDryRunPlan = {
  name: string
  description: string
  maxConcurrency: number
  maxAgents: number
  totalAgents: number
  phases: WorkflowDryRunPhase[]
}
```

- [ ] **Step 2: Type-check the new file**

Run:

```bash
pnpm exec tsc --noEmit --pretty false
```

Expected: exits 0.

---

### Task 4: Add pure workflow spec validation

**Files:**
- Create: `src/tools/WorkflowTool/validateWorkflowSpec.ts`
- Test: add test file according to the repository's existing test layout if tests are present for `src/tools/WorkflowTool`; otherwise validate with typecheck and build in this phase.

- [ ] **Step 1: Write validation module**

Create `src/tools/WorkflowTool/validateWorkflowSpec.ts` with this content:

```ts
import type {
  WorkflowDryRunPhase,
  WorkflowDryRunPlan,
  WorkflowReviewMode,
  WorkflowSpec,
} from './workflowSpec.js'

const DEFAULT_MAX_CONCURRENCY = 4
const DEFAULT_MAX_AGENTS = 32
const DEFAULT_PHASE_FANOUT = 1
const DEFAULT_PHASE_CONCURRENCY = 1
const REVIEW_MODES = new Set<WorkflowReviewMode>([
  'none',
  'cross-check',
  'adversarial',
  'synthesis',
])

export function validateWorkflowSpec(spec: WorkflowSpec): WorkflowDryRunPlan {
  if (!spec.name.trim()) throw new Error('Workflow name is required')
  if (!spec.description.trim()) throw new Error('Workflow description is required')
  if (spec.phases.length === 0) throw new Error('Workflow must contain at least one phase')

  const maxConcurrency = spec.defaults?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
  const maxAgents = spec.defaults?.maxAgents ?? DEFAULT_MAX_AGENTS

  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('Workflow maxConcurrency must be a positive integer')
  }

  if (!Number.isInteger(maxAgents) || maxAgents < 1) {
    throw new Error('Workflow maxAgents must be a positive integer')
  }

  const phaseIds = new Set<string>()
  const phases: WorkflowDryRunPhase[] = []

  for (const phase of spec.phases) {
    if (!phase.id.trim()) throw new Error('Workflow phase id is required')
    if (phaseIds.has(phase.id)) throw new Error(`Duplicate workflow phase id: ${phase.id}`)
    phaseIds.add(phase.id)

    if (!phase.description.trim()) {
      throw new Error(`Workflow phase ${phase.id} description is required`)
    }

    if (!phase.prompt.trim()) {
      throw new Error(`Workflow phase ${phase.id} prompt is required`)
    }

    const fanout = phase.fanout ?? DEFAULT_PHASE_FANOUT
    const concurrency = phase.concurrency ?? DEFAULT_PHASE_CONCURRENCY
    const review = phase.review ?? 'none'

    if (!Number.isInteger(fanout) || fanout < 1) {
      throw new Error(`Workflow phase ${phase.id} fanout must be a positive integer`)
    }

    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`Workflow phase ${phase.id} concurrency must be a positive integer`)
    }

    if (concurrency > fanout) {
      throw new Error(`Workflow phase ${phase.id} concurrency cannot exceed fanout`)
    }

    if (!REVIEW_MODES.has(review)) {
      throw new Error(`Workflow phase ${phase.id} has unsupported review mode: ${review}`)
    }

    phases.push({
      id: phase.id,
      description: phase.description,
      dependsOn: phase.dependsOn ?? [],
      fanout,
      concurrency,
      review,
      agentType: phase.agentType,
      model: phase.model,
    })
  }

  for (const phase of phases) {
    for (const dependency of phase.dependsOn) {
      if (!phaseIds.has(dependency)) {
        throw new Error(`Workflow phase ${phase.id} depends on unknown phase: ${dependency}`)
      }

      if (dependency === phase.id) {
        throw new Error(`Workflow phase ${phase.id} cannot depend on itself`)
      }
    }
  }

  assertAcyclic(phases)

  const totalAgents = phases.reduce((sum, phase) => sum + phase.fanout, 0)
  if (totalAgents > maxAgents) {
    throw new Error(`Workflow requests ${totalAgents} agents, exceeding maxAgents ${maxAgents}`)
  }

  if (Math.max(...phases.map(phase => phase.concurrency)) > maxConcurrency) {
    throw new Error('A workflow phase exceeds maxConcurrency')
  }

  return {
    name: spec.name,
    description: spec.description,
    maxConcurrency,
    maxAgents,
    totalAgents,
    phases,
  }
}

function assertAcyclic(phases: WorkflowDryRunPhase[]): void {
  const byId = new Map(phases.map(phase => [phase.id, phase]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  function visit(id: string): void {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`Workflow dependency cycle includes phase: ${id}`)

    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      visit(dependency)
    }
    visiting.delete(id)
    visited.add(id)
  }

  for (const phase of phases) visit(phase.id)
}
```

- [ ] **Step 2: Type-check validation**

Run:

```bash
pnpm exec tsc --noEmit --pretty false
```

Expected: exits 0.

- [ ] **Step 3: Build after validation module**

Run:

```bash
pnpm build
```

Expected: exits 0.

---

### Task 5: Add dry-run formatting

**Files:**
- Create: `src/tools/WorkflowTool/formatWorkflowDryRun.ts`

- [ ] **Step 1: Write dry-run formatter**

Create `src/tools/WorkflowTool/formatWorkflowDryRun.ts` with this content:

```ts
import type { WorkflowDryRunPlan } from './workflowSpec.js'

export function formatWorkflowDryRun(plan: WorkflowDryRunPlan): string {
  const lines = [
    `Workflow: ${plan.name}`,
    plan.description,
    '',
    `Max concurrency: ${plan.maxConcurrency}`,
    `Max agents: ${plan.maxAgents}`,
    `Planned agents: ${plan.totalAgents}`,
    '',
    'Phases:',
  ]

  for (const phase of plan.phases) {
    const dependencies = phase.dependsOn.length ? phase.dependsOn.join(', ') : 'none'
    lines.push(
      `- ${phase.id}: ${phase.description}`,
      `  depends on: ${dependencies}`,
      `  fanout: ${phase.fanout}`,
      `  concurrency: ${phase.concurrency}`,
      `  review: ${phase.review}`,
    )

    if (phase.agentType) lines.push(`  agent type: ${phase.agentType}`)
    if (phase.model) lines.push(`  model: ${phase.model}`)
  }

  return lines.join('\n')
}
```

- [ ] **Step 2: Type-check formatter**

Run:

```bash
pnpm exec tsc --noEmit --pretty false
```

Expected: exits 0.

---

### Task 6: Add fixture workflow specs for dry-run development

**Files:**
- Create: `docs/workflows/deep-research-dry-run.json`
- Create: `docs/workflows/code-audit-dry-run.json`

- [ ] **Step 1: Create the workflows docs directory and research fixture**

Create `docs/workflows/deep-research-dry-run.json` with this content:

```json
{
  "name": "deep-research-dry-run",
  "description": "Example dry-run workflow for multi-angle research with cross-check and synthesis phases.",
  "defaults": {
    "maxConcurrency": 4,
    "maxAgents": 12,
    "permissionMode": "default"
  },
  "phases": [
    {
      "id": "research",
      "description": "Research independent angles of the question.",
      "prompt": "Research one independent angle of the supplied question and report sourced findings.",
      "agentType": "general-purpose",
      "fanout": 4,
      "concurrency": 4,
      "review": "none",
      "output": {
        "format": "findings"
      }
    },
    {
      "id": "cross-check",
      "description": "Check research findings against each other and identify unsupported claims.",
      "prompt": "Review the prior findings, challenge unsupported claims, and identify consensus points.",
      "agentType": "general-purpose",
      "dependsOn": ["research"],
      "fanout": 2,
      "concurrency": 2,
      "review": "cross-check",
      "output": {
        "format": "findings"
      }
    },
    {
      "id": "synthesis",
      "description": "Synthesize only claims that survived cross-checking.",
      "prompt": "Produce a concise cited synthesis from the verified findings.",
      "agentType": "general-purpose",
      "dependsOn": ["cross-check"],
      "fanout": 1,
      "concurrency": 1,
      "review": "synthesis",
      "output": {
        "format": "report"
      }
    }
  ]
}
```

- [ ] **Step 2: Create the code audit fixture**

Create `docs/workflows/code-audit-dry-run.json` with this content:

```json
{
  "name": "code-audit-dry-run",
  "description": "Example dry-run workflow for codebase audit with independent review lenses.",
  "defaults": {
    "maxConcurrency": 3,
    "maxAgents": 9,
    "permissionMode": "default"
  },
  "phases": [
    {
      "id": "security-review",
      "description": "Review security-sensitive behavior.",
      "prompt": "Audit the target paths for security issues and report high-confidence findings.",
      "agentType": "general-purpose",
      "fanout": 1,
      "concurrency": 1,
      "review": "none",
      "output": {
        "format": "findings"
      }
    },
    {
      "id": "architecture-review",
      "description": "Review architecture and maintainability risks.",
      "prompt": "Audit the target paths for architecture and maintainability risks.",
      "agentType": "general-purpose",
      "fanout": 1,
      "concurrency": 1,
      "review": "none",
      "output": {
        "format": "findings"
      }
    },
    {
      "id": "test-review",
      "description": "Review test coverage and verification gaps.",
      "prompt": "Audit the target paths for missing tests and verification gaps.",
      "agentType": "general-purpose",
      "fanout": 1,
      "concurrency": 1,
      "review": "none",
      "output": {
        "format": "findings"
      }
    },
    {
      "id": "synthesis",
      "description": "Combine independent audit findings.",
      "prompt": "Synthesize the independent audit results and remove duplicate or unsupported findings.",
      "dependsOn": ["security-review", "architecture-review", "test-review"],
      "fanout": 1,
      "concurrency": 1,
      "review": "synthesis",
      "output": {
        "format": "report"
      }
    }
  ]
}
```

- [ ] **Step 3: Validate fixture JSON syntax**

Run:

```bash
node -e "for (const f of ['docs/workflows/deep-research-dry-run.json','docs/workflows/code-audit-dry-run.json']) JSON.parse(require('fs').readFileSync(f, 'utf8'));"
```

Expected: exits 0.

---

### Task 7: Prototype dry-run validation behind a pure script

**Files:**
- Create: `scripts/workflow-dry-run.mjs`

- [ ] **Step 1: Create a standalone dry-run script**

Create `scripts/workflow-dry-run.mjs` with this content:

```js
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(scriptDir, '..')
const file = process.argv[2]

if (!file) {
  console.error('Usage: node scripts/workflow-dry-run.mjs <workflow-spec.json>')
  process.exit(1)
}

const specPath = path.resolve(projectDir, file)
const spec = JSON.parse(await fs.promises.readFile(specPath, 'utf8'))
const plan = validateWorkflowSpec(spec)
console.log(formatWorkflowDryRun(plan))

function validateWorkflowSpec(spec) {
  if (!String(spec.name ?? '').trim()) throw new Error('Workflow name is required')
  if (!String(spec.description ?? '').trim()) throw new Error('Workflow description is required')
  if (!Array.isArray(spec.phases) || spec.phases.length === 0) {
    throw new Error('Workflow must contain at least one phase')
  }

  const maxConcurrency = spec.defaults?.maxConcurrency ?? 4
  const maxAgents = spec.defaults?.maxAgents ?? 32
  const ids = new Set()
  const phases = []

  for (const phase of spec.phases) {
    const id = String(phase.id ?? '')
    if (!id.trim()) throw new Error('Workflow phase id is required')
    if (ids.has(id)) throw new Error(`Duplicate workflow phase id: ${id}`)
    ids.add(id)

    const description = String(phase.description ?? '')
    const prompt = String(phase.prompt ?? '')
    if (!description.trim()) throw new Error(`Workflow phase ${id} description is required`)
    if (!prompt.trim()) throw new Error(`Workflow phase ${id} prompt is required`)

    const fanout = phase.fanout ?? 1
    const concurrency = phase.concurrency ?? 1
    const review = phase.review ?? 'none'

    if (!Number.isInteger(fanout) || fanout < 1) {
      throw new Error(`Workflow phase ${id} fanout must be a positive integer`)
    }
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`Workflow phase ${id} concurrency must be a positive integer`)
    }
    if (concurrency > fanout) {
      throw new Error(`Workflow phase ${id} concurrency cannot exceed fanout`)
    }

    phases.push({
      id,
      description,
      dependsOn: phase.dependsOn ?? [],
      fanout,
      concurrency,
      review,
      agentType: phase.agentType,
      model: phase.model,
    })
  }

  for (const phase of phases) {
    for (const dependency of phase.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Workflow phase ${phase.id} depends on unknown phase: ${dependency}`)
      if (dependency === phase.id) throw new Error(`Workflow phase ${phase.id} cannot depend on itself`)
    }
  }

  const totalAgents = phases.reduce((sum, phase) => sum + phase.fanout, 0)
  if (totalAgents > maxAgents) throw new Error(`Workflow requests ${totalAgents} agents, exceeding maxAgents ${maxAgents}`)
  if (Math.max(...phases.map(phase => phase.concurrency)) > maxConcurrency) {
    throw new Error('A workflow phase exceeds maxConcurrency')
  }

  return {
    name: spec.name,
    description: spec.description,
    maxConcurrency,
    maxAgents,
    totalAgents,
    phases,
  }
}

function formatWorkflowDryRun(plan) {
  const lines = [
    `Workflow: ${plan.name}`,
    plan.description,
    '',
    `Max concurrency: ${plan.maxConcurrency}`,
    `Max agents: ${plan.maxAgents}`,
    `Planned agents: ${plan.totalAgents}`,
    '',
    'Phases:',
  ]

  for (const phase of plan.phases) {
    const dependencies = phase.dependsOn.length ? phase.dependsOn.join(', ') : 'none'
    lines.push(
      `- ${phase.id}: ${phase.description}`,
      `  depends on: ${dependencies}`,
      `  fanout: ${phase.fanout}`,
      `  concurrency: ${phase.concurrency}`,
      `  review: ${phase.review}`,
    )
    if (phase.agentType) lines.push(`  agent type: ${phase.agentType}`)
    if (phase.model) lines.push(`  model: ${phase.model}`)
  }

  return lines.join('\n')
}
```

- [ ] **Step 2: Run dry-run script on research fixture**

Run:

```bash
node scripts/workflow-dry-run.mjs docs/workflows/deep-research-dry-run.json
```

Expected output contains:

```text
Workflow: deep-research-dry-run
Planned agents: 7
- research: Research independent angles of the question.
- cross-check: Check research findings against each other and identify unsupported claims.
- synthesis: Synthesize only claims that survived cross-checking.
```

- [ ] **Step 3: Run dry-run script on code audit fixture**

Run:

```bash
node scripts/workflow-dry-run.mjs docs/workflows/code-audit-dry-run.json
```

Expected output contains:

```text
Workflow: code-audit-dry-run
Planned agents: 4
- security-review: Review security-sensitive behavior.
- architecture-review: Review architecture and maintainability risks.
- test-review: Review test coverage and verification gaps.
- synthesis: Combine independent audit findings.
```

---

### Task 8: Document future runtime integration points

**Files:**
- Modify: `docs/dynamic-workflow-agent-orchestration.md`

- [ ] **Step 1: Add integration details**

Append this section to `docs/dynamic-workflow-agent-orchestration.md`:

```markdown
## Runtime integration points

Implemented dry-run and inspection integration:

1. `src/tools/WorkflowTool/workflowSpec.ts` defines the stable declarative spec shape.
2. `src/tools/WorkflowTool/validateWorkflowSpec.ts` rejects invalid workflow graphs before any agent starts.
3. `src/tools/WorkflowTool/formatWorkflowDryRun.ts` powers dry-run output.
4. `src/tools/WorkflowTool/workflowDiscovery.ts` discovers valid local specs from project workflow directories.
5. `src/tools/WorkflowTool/createWorkflowCommand.ts` exposes workflow-backed prompt commands when `WORKFLOW_SCRIPTS` is enabled and valid definitions exist.
6. `src/tools/WorkflowTool/WorkflowTool.ts` provides read-only `list`, `show`, and `dry-run` inspection.
7. `src/commands/workflows/workflows.ts` provides the local `/workflows` inspection command.

Future executable runtime integration:

1. `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` grows typed phase and agent progress state.
2. Agent execution maps phases to the existing `AgentTool` path rather than directly invoking shell or filesystem tools.
3. Skip and retry controls implement `skipWorkflowAgent()` and `retryWorkflowAgent()` only after phase state is explicit.
4. Running workflow UI exposes progress, stop, pause/resume, retry, skip, token usage, and elapsed time.

Runtime implementation should preserve the current feature-gated import pattern. Do not introduce static imports that defeat dead-code elimination for workflow-only code.
```

- [ ] **Step 2: Check document whitespace**

Run:

```bash
git diff --check -- docs/dynamic-workflow-agent-orchestration.md
```

Expected: no output.

---

### Task 9: Run final validation for documentation and dry-run foundation

**Files:**
- Inspect all files changed by this plan.

- [ ] **Step 1: Check unfinished-marker text across new docs**

Run:

```bash
grep -R -nE 'TB[D]|TO[D]O|implement[[:space:]]+later|fill[[:space:]]+in|placeholde[r]' docs/dynamic-workflow-agent-orchestration.md docs/workflows docs/superpowers/specs/2026-06-05-dynamic-workflow-agent-orchestration-design.md docs/superpowers/plans/2026-06-05-dynamic-workflow-agent-orchestration.md || true
```

Expected: no output.

- [ ] **Step 2: Validate JSON fixtures**

Run:

```bash
node -e "for (const f of ['docs/workflows/deep-research-dry-run.json','docs/workflows/code-audit-dry-run.json']) JSON.parse(require('fs').readFileSync(f, 'utf8'));"
```

Expected: exits 0.

- [ ] **Step 3: Run both dry-run fixtures**

Run:

```bash
node scripts/workflow-dry-run.mjs docs/workflows/deep-research-dry-run.json
node scripts/workflow-dry-run.mjs docs/workflows/code-audit-dry-run.json
```

Expected: both commands print phase plans and exit 0.

- [ ] **Step 4: Run code validation**

Run:

```bash
pnpm exec tsc --noEmit --pretty false
pnpm build
```

Expected: both commands exit 0.

- [ ] **Step 5: Run repository checks**

Run:

```bash
pnpm lint
pnpm audit:missing
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 6: Review final diff**

Run:

```bash
git status --short
git diff -- docs/dynamic-workflow-agent-orchestration.md docs/README.md docs/workflows scripts/workflow-dry-run.mjs src/tools/WorkflowTool docs/superpowers/specs/2026-06-05-dynamic-workflow-agent-orchestration-design.md docs/superpowers/plans/2026-06-05-dynamic-workflow-agent-orchestration.md
```

Expected: diff is limited to dynamic workflow and agent orchestration documentation, dry-run fixtures, and dry-run validation foundation.

- [ ] **Step 7: Do not commit automatically**

Leave changes uncommitted unless the user explicitly asks for a commit.
