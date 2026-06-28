import { registerBundledSkill } from '../bundledSkills.js'

const WORKFLOW_PROMPT = `# Workflow Skill

Use this model-internal skill to decide when and how to use Claude Code dynamic workflows.

## Core rule

Dynamic workflows are structured orchestration. Use the Workflow or WorkflowTool tools to run or inspect them. Do not manually perform phase work in the main thread.

## When to use Workflow

Use Workflow for large multi-agent work, deep research, broad codebase audits, migrations, cross-checking, fanout, synthesis, or when the user asks for dynamic workflow / workflow / ultracode-style orchestration.

Prefer saved workflows when one exists:

\`\`\`ts
Workflow({ name: 'deep-research', args: userInput })
\`\`\`

Use official-compatible inline scripts only when a saved workflow is not enough. Workflow scripts must start with:

\`\`\`js
export const meta = { name, description, phases }
\`\`\`

Then orchestrate with workflow runtime globals such as agent(), parallel(), pipeline(), phase(), and log(). Scripts orchestrate agents only; they must not directly perform shell or filesystem work.

Use persisted script paths for edits and resumes:

\`\`\`ts
Workflow({ scriptPath, args, resumeFromRunId })
\`\`\`

## When to use WorkflowTool

Use WorkflowTool for inspection and control when the tool is available:

- list: discover saved workflow specs
- show: inspect metadata
- dry-run: inspect the phase graph
- run: execute a validated workflow spec through the workflow runtime
- status: inspect a workflow task
- pause: pause a running workflow
- resume: print the resume prompt for a paused workflow

Do not copy a dry-run plan from prompt text and execute it as a raw plan when a selector, name, or scriptPath exists. Reload by selector/scriptPath so validation, task state, permission previews, hooks, resume, and LocalWorkflowTask progress stay intact.

## Permission and execution boundaries

- Preserve normal tool permissions and hooks.
- Let workflow phases launch agents through the workflow runtime.
- Do not narrow child agents to the parent orchestration tool scope.
- For long-running resumes, use the scriptPath and resumeFromRunId returned by prior workflow output.
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
