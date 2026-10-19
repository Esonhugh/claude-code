import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createWorkflowOrchestrator } from './workflowOrchestrator.js'
import { hasWorkflowScriptMeta, parseWorkflowScript, workflowErrorMessage } from './workflowScriptParser.js'
import type { WorkflowArgs, WorkflowPhaseSpec, WorkflowSpec } from './workflowSpec.js'

type WorkflowScriptContext = {
  args: WorkflowArgs | undefined
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

const DATE_ERROR = 'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.'
const RANDOM_ERROR = 'Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.'

function transformModuleSyntax(source: string): string {
  return source
    .replace(/export\s+default\s+/g, 'module.exports.default = ')
    .replace(/export\s+const\s+workflowSpec\s*=\s*/g, 'module.exports.default = ')
}

function createWorkflowMath(): Math {
  const workflowMath = Object.create(Math) as Math
  Object.defineProperty(workflowMath, 'random', {
    value: () => {
      throw new Error(RANDOM_ERROR)
    },
  })
  return Object.freeze(workflowMath)
}

function parseWorkflowArgs(args: WorkflowArgs | undefined): WorkflowArgs | undefined {
  if (typeof args !== 'string') return args
  const trimmed = args.trim()
  if (!trimmed) return ''
  try {
    return JSON.parse(trimmed) as WorkflowArgs
  } catch {
    return args
  }
}

function WorkflowDate(): never {
  throw new Error(DATE_ERROR)
}

async function runOrchestrationExport(
  exported: () => Promise<void> | void,
  orchestrator: ReturnType<typeof createWorkflowOrchestrator>,
  filePath: string,
): Promise<WorkflowSpec> {
  await Promise.race([
    Promise.resolve(exported()),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Workflow script timed out: ${filePath}`)), 1000)
    }),
  ])
  return orchestrator.toSpec()
}

// Official 2.1.292 launches a meta script after parsing its meta and compiling the
// body; only the workflow runtime runs the body, so no agent() call happens here.
export function preflightWorkflowScript(source: string, filePath: string): ReturnType<typeof parseWorkflowScript> {
  const parsed = parseWorkflowScript(source)
  try {
    // vm.Script compiles lazily on Bun 1.3, so it would not surface syntax errors here.
    vm.compileFunction(`(async () => {\n${parsed.scriptBody}\n})`, [], { filename: filePath })
  } catch (error) {
    throw new Error(`Workflow script has a syntax error and was not launched:\n${workflowErrorMessage(error, 'Workflow script failed to compile')}`)
  }
  return parsed
}

function loadOfficialWorkflowScriptSpec(filePath: string, source: string): WorkflowSpec {
  const parsed = preflightWorkflowScript(source, filePath)
  return {
    name: parsed.meta.name,
    description: parsed.meta.description,
    phases: (parsed.meta.phases ?? []).map(phase => ({
      id: phase.title,
      description: phase.detail ?? phase.title,
      prompt: phase.detail ?? phase.title,
      fanout: 0,
    })),
    meta: parsed.meta,
    runtime: {
      kind: 'javascript-worker',
      sourcePath: filePath,
      isolated: true,
    },
    sourcePath: filePath,
    runScriptSnapshot: source,
  }
}

export async function loadWorkflowScriptSpec(
  filePath: string,
  args?: WorkflowArgs,
): Promise<WorkflowSpec> {
  const source = await readFile(filePath, 'utf8')
  if (hasWorkflowScriptMeta(source)) {
    return loadOfficialWorkflowScriptSpec(filePath, source)
  }
  const parsedArgs = parseWorkflowArgs(args)
  const context: WorkflowScriptContext = { args: parsedArgs }
  const module = {
    exports: {} as {
      default?: WorkflowInput | WorkflowSpec | (() => Promise<void> | void)
    },
  }
  const orchestrator = createWorkflowOrchestrator({
    workflowRunId: 'dry-run',
    maxAgents: 1000,
  })
  const sandbox = vm.createContext({
    args: parsedArgs,
    module,
    exports: module.exports,
    workflow: (workflow: WorkflowInput) => normalizeWorkflow(workflow, context),
    agent: (input: WorkflowPhaseInput | Parameters<typeof orchestrator.agent>[0]) =>
      'label' in input ? orchestrator.agent(input) : input,
    parallel: orchestrator.parallel,
    series: orchestrator.series,
    retry: orchestrator.retry,
    loopUntil: orchestrator.loopUntil,
    review: orchestrator.review,
    refute: orchestrator.refute,
    synthesize: orchestrator.synthesize,
    vote: orchestrator.vote,
    log: orchestrator.log,
    Date: Object.assign(WorkflowDate, { now: WorkflowDate }),
    Math: createWorkflowMath(),
  })
  const script = new vm.Script(transformModuleSyntax(source), {
    filename: filePath,
  })
  script.runInContext(sandbox, { timeout: 1000 })

  // Support both `export default` and bare function-expression formats
  let exported = module.exports.default
  if (!exported && typeof sandbox._lastResult === 'function') {
    exported = sandbox._lastResult
  }
  if (!exported) {
    // Try evaluating as a bare expression (arrow fn / function)
    try {
      const exprScript = new vm.Script(`module.exports.default = ${source.trim()}`, { filename: filePath })
      exprScript.runInContext(sandbox, { timeout: 1000 })
      exported = module.exports.default
    } catch { /* ignore */ }
  }
  if (!exported) {
    throw new Error(`Workflow script did not export a workflow: ${filePath}`)
  }

  const workflowSpec =
    typeof exported === 'function'
      ? await runOrchestrationExport(exported, orchestrator, filePath)
      : exported

  if (!Array.isArray(workflowSpec.phases)) {
    throw new Error(`Workflow script exported invalid phases: ${filePath}`)
  }

  return structuredClone({
    ...normalizeWorkflow(workflowSpec as WorkflowInput, context),
    runtime: {
      kind: 'javascript-worker' as const,
      sourcePath: filePath,
      isolated: true,
    },
    sourcePath: filePath,
    runScriptSnapshot: source,
  })
}
