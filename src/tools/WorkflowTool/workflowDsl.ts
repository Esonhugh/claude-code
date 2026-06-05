import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import type { WorkflowPhaseSpec, WorkflowSpec } from './workflowSpec.js'

type WorkflowScriptContext = {
  args: string
}

type WorkflowPhaseInput = Omit<WorkflowPhaseSpec, 'prompt'> & {
  prompt: string | ((context: WorkflowScriptContext) => string)
}

type WorkflowInput = Omit<WorkflowSpec, 'phases'> & {
  phases: WorkflowPhaseInput[]
}

function normalizePhase(
  phase: WorkflowPhaseInput,
  context: WorkflowScriptContext,
): WorkflowPhaseSpec {
  return {
    ...phase,
    prompt:
      typeof phase.prompt === 'function' ? phase.prompt(context) : phase.prompt,
  }
}

function normalizeWorkflow(
  workflow: WorkflowInput,
  context: WorkflowScriptContext,
): WorkflowSpec {
  return {
    ...workflow,
    phases: workflow.phases.map(phase => normalizePhase(phase, context)),
  }
}

function transformModuleSyntax(source: string): string {
  return source
    .replace(/export\s+default\s+/g, 'module.exports.default = ')
    .replace(/export\s+const\s+workflowSpec\s*=\s*/g, 'module.exports.default = ')
}

export async function loadWorkflowScriptSpec(
  filePath: string,
  args = '',
): Promise<WorkflowSpec> {
  const context: WorkflowScriptContext = { args }
  const module = { exports: {} as { default?: WorkflowInput | WorkflowSpec } }
  const sandbox = vm.createContext({
    args,
    module,
    exports: module.exports,
    workflow: (workflow: WorkflowInput) => normalizeWorkflow(workflow, context),
    agent: (phase: WorkflowPhaseInput) => phase,
  })
  const source = await readFile(filePath, 'utf8')
  const script = new vm.Script(transformModuleSyntax(source), {
    filename: filePath,
  })
  script.runInContext(sandbox, { timeout: 1000 })

  const exported = module.exports.default
  if (!exported) {
    throw new Error(`Workflow script did not export a workflow: ${filePath}`)
  }

  if (!Array.isArray(exported.phases)) {
    throw new Error(`Workflow script exported invalid phases: ${filePath}`)
  }

  return structuredClone({
    ...normalizeWorkflow(exported as WorkflowInput, context),
    runtime: {
      kind: 'javascript-worker' as const,
      sourcePath: filePath,
      isolated: true,
    },
    sourcePath: filePath,
    runScriptSnapshot: source,
  })
}
