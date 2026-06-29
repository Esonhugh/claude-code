import { registerBundledSkill } from '../bundledSkills.js'

const WORKFLOW_PROMPT = `# Workflow Skill

Use this model-internal skill to decide when and how to use Claude Code dynamic workflows.

## Core rule

Dynamic workflows are structured orchestration. Use Workflow for execution. Use WorkflowTool for inspection and control when it is available. Do not manually perform phase work in the main thread.

## Explicit opt-in requirement

Only execute Workflow when the user has explicitly opted into workflow-scale orchestration. Explicit opt-in includes:

- The user asks for dynamic workflow, workflow, ultracode-style orchestration, multi-agent orchestration, fan-out, broad audit, migration, deep research, or cross-checking.
- The user asks to run a named or saved workflow.
- A loaded skill or command instruction explicitly tells you to call Workflow.
- A system reminder says ultracode or dynamic workflow mode is active for the turn.

If a task merely could benefit from a workflow but the user did not opt in, do not silently call Workflow. Use normal tools or briefly explain what a workflow would do and ask before running one.

## Tool selection

Use Workflow for execution:

\`\`\`ts
Workflow({ name: 'deep-research', args: userInput })
\`\`\`

Use official-compatible inline scripts only when a saved workflow is not enough:

\`\`\`ts
Workflow({ script, name, args })
\`\`\`

Use persisted script paths for edits and resumes:

\`\`\`ts
Workflow({ scriptPath, args, resumeFromRunId })
\`\`\`

Use WorkflowTool for inspection and control when available:

- list: discover saved workflow specs.
- show: inspect metadata.
- dry-run: inspect the phase graph.
- status: inspect a workflow task.
- pause: pause a running workflow.
- resume: print the resume prompt for a paused workflow.
- run: execute a validated local spec when using the local WorkflowTool surface.

Do not treat /workflows text arguments as the launcher. /workflows is display and management UI.

## Script rules

Every inline or scriptPath workflow script must start with:

\`\`\`js
export const meta = { name, description, phases }
\`\`\`

The meta object must be a pure literal, matching official AST-parser expectations:

- Allowed values: string/number/boolean/null literals, arrays, plain objects, negative numeric literals, and template literals without expressions.
- Rejected values: variables, identifiers, function calls, spread, sparse arrays, computed keys, methods, accessors, template interpolation, TypeScript syntax, and reserved keys such as __proto__, constructor, and prototype.
- Required fields are non-empty string name and description.
- Use phases to preview progress groups; phase entries should use string title, and optional string detail/model.

The script body orchestrates agents with workflow runtime globals:

- agent(prompt, opts): spawn a subagent. Use agent({ schema }) when structured output is needed, and expect the subagent to return via the structured output tool rather than prose.
- pipeline(items, stage1, stage2, ...): run each item through all stages independently.
- parallel(thunks): run independent tasks concurrently and wait for all results. Pass thunks/functions, not promises.
- phase(title): group later agent calls under a progress phase.
- log(message): emit progress.
- args: user input passed to Workflow. Pass arrays/objects as real JSON values, not JSON-encoded strings.
- budget: token budget helper when available.
- workflow(nameOrRef, args): call a child workflow when available; avoid deep nesting.

Scripts orchestrate agents only. They must not directly perform shell or filesystem work. Agents perform the actual work under normal tool permissions and hooks.

Workflow scripts run in a constrained official-style JavaScript environment. Do not depend on Node filesystem or shell APIs, dynamic import, Date.now(), bare Date(), argless new Date(), Math.random(), eval, Function, WebAssembly, or deep child workflow nesting. Pass time, random seeds, and external data through args when needed.

## pipeline() vs parallel()

Default to pipeline() for multi-stage per-item work. It avoids unnecessary barriers because item A can advance while item B is still in an earlier stage.

Use parallel() as a barrier only when the next step genuinely needs all previous results together, such as deduping across all findings, comparing all candidates, or deciding whether the total count is zero.

parallel(thunks) expects an array of functions, not promises. Write () => agent(...) entries so the workflow runtime controls launch timing.

Failed branches or budget-limited branches can produce null results while preserving partial workflow progress. Synthesis stages must handle null or missing branch outputs.

Do not add a barrier just to flatten, map, filter, or make code look cleaner. Put simple transforms inside a pipeline stage.

## Loop and budget safety

Loop-until-dry patterns must include a hard cap such as max rounds or max new findings. budget.remaining() may be Infinity when no token budget is configured, so do not rely on it as the only loop bound.

## Quality patterns

Use these patterns when they fit the task:

- Adversarial verify: ask independent skeptics to refute each finding before accepting it.
- Perspective-diverse verify: use distinct lenses such as correctness, security, performance, and reproducibility.
- Judge panel: generate multiple independent approaches, score them, then synthesize the best parts.
- Loop-until-dry: keep discovering until consecutive rounds find nothing new, with an explicit hard cap.
- Multi-modal sweep: search by different modalities such as file structure, content, ownership, time, or runtime behavior.
- Completeness critic: run a final agent asking what evidence, modality, or verification is missing.
- No silent caps: if coverage is bounded or sampled, log what was skipped.

Scale to what the user asked for. A broad audit or migration deserves stronger fan-out and verification than a quick check.

## Resume and iteration

Workflow runs should expose a scriptPath and run id when supported. To iterate, edit the persisted script and call Workflow with scriptPath and resumeFromRunId. Completed unchanged agent calls should return cached results when the runtime supports resume.

Do not copy a dry-run plan from prompt text and execute it as a raw plan when a selector, name, or scriptPath exists. Reload by selector/scriptPath so validation, task state, permission previews, hooks, resume, and LocalWorkflowTask progress stay intact.

## Permission and execution boundaries

- Preserve normal tool permissions and hooks.
- Let workflow phases launch agents through the workflow runtime.
- Do not narrow child agents to the parent orchestration tool scope.
- Do not promote /workflow or /workflows run as user-facing command guidance.
- Do not manually perform phase work in the main thread.
`

export function registerWorkflowSkill(): void {
  registerBundledSkill({
    name: 'workflow',
    description:
      'Use when dynamic workflow, Workflow, ultracode-style orchestration, deep research, fanout, multi-agent cross-checking, migration, audit, or synthesis work is needed',
    whenToUse:
      'Use for dynamic workflow, Workflow, ultracode-style orchestration, deep research, fanout, multi-agent cross-checking, large codebase migration, broad audit, or synthesis tasks. Do not use for simple one-step tasks.',
    userInvocable: false,
    async getPromptForCommand() {
      return [{ type: 'text', text: WORKFLOW_PROMPT }]
    },
  })
}
