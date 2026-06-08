import type { WorkflowArgs, WorkflowPhaseSpec, WorkflowSpec } from './workflowSpec.js'

export const DATE_ERROR = 'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.'
export const RANDOM_ERROR = 'Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.'

export type WorkflowRuntimeAgentOptions = {
  label?: string
  phase?: string
  schema?: object
  model?: string
  isolation?: 'worktree'
  agentType?: string
}

export type WorkflowRuntimeAgentResult = {
  label: string
  output: string
}

type PipelineStage<TInput = any, TOutput = any> = (
  value: TInput,
  original: any,
  index: number,
) => Promise<TOutput> | TOutput

type JsonSchemaShape = {
  type?: string
  properties?: Record<string, JsonSchemaShape>
  items?: JsonSchemaShape
  minItems?: number
  required?: string[]
}

function placeholderForSchema(
  schema: object | undefined,
  path: string,
): unknown {
  if (!schema || typeof schema !== 'object') return undefined
  const shape = schema as JsonSchemaShape
  if (shape.type === 'object' || shape.properties) {
    const result: Record<string, unknown> = {}
    const keys = [
      ...new Set([
        ...(shape.required ?? []),
        ...Object.keys(shape.properties ?? {}),
      ]),
    ]
    for (const key of keys) {
      result[key] = placeholderForSchema(
        shape.properties?.[key],
        `${path}.${key}`,
      )
    }
    return result
  }
  if (shape.type === 'array' || shape.items) {
    const length = Math.max(1, shape.minItems ?? 1)
    return Array.from({ length }, (_, index) =>
      placeholderForSchema(shape.items, `${path}[${index}]`),
    )
  }
  if (shape.type === 'number' || shape.type === 'integer') return 0
  if (shape.type === 'boolean') return false
  return `{{agent:${path}}}`
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

function WorkflowDate(): never {
  throw new Error(DATE_ERROR)
}

export function createWorkflowRuntimeGlobals({
  args,
  budgetTotal = null,
  log,
}: {
  args?: WorkflowArgs
  workflowRunId: string
  budgetTotal?: number | null
  log?: (message: string) => void
}) {
  const phases: WorkflowPhaseSpec[] = []
  let currentPhase: string | undefined
  let lastGroupedPhaseId: string | undefined
  let callIndex = 0
  let spent = 0

  function nextLabel(opts: WorkflowRuntimeAgentOptions | undefined): string {
    return opts?.label || `agent-${callIndex + 1}`
  }

  function ensurePhasePlaceholder(title: string): void {
    if (phases.some(phase => phase.id === title)) return
    phases.push({
      id: title,
      description: title,
      prompt: `Run workflow phase: ${title}`,
      fanout: 0,
    })
  }

  function removePhasePlaceholder(title: string): void {
    const placeholderIndex = phases.findIndex(
      phase => phase.id === title && phase.prompt === `Run workflow phase: ${title}`,
    )
    if (placeholderIndex !== -1) phases.splice(placeholderIndex, 1)
  }

  function upsertGroupedAgentPhase({
    phaseId,
    label,
    prompt,
    opts,
  }: {
    phaseId: string
    label: string
    prompt: string
    opts?: WorkflowRuntimeAgentOptions
  }): void {
    removePhasePlaceholder(phaseId)
    const phaseIndex = phases.findIndex(phase => phase.id === phaseId)
    const previousPhase = lastGroupedPhaseId && lastGroupedPhaseId !== phaseId
      ? lastGroupedPhaseId
      : undefined
    lastGroupedPhaseId = phaseId
    const agentLabels = phaseIndex === -1
      ? [label]
      : [...(phases[phaseIndex]?.agentLabels ?? []), label]
    const agentPrompts = phaseIndex === -1
      ? [prompt]
      : [...(phases[phaseIndex]?.agentPrompts ?? []), prompt]
    const phaseSpec: WorkflowPhaseSpec = {
      id: phaseId,
      description: opts?.phase ?? currentPhase ?? phaseId,
      prompt: agentPrompts[0] ?? prompt,
      displayName: phaseId,
      ...(previousPhase ? { dependsOn: [previousPhase] } : {}),
      fanout: agentLabels.length,
      concurrency: agentLabels.length,
      agentLabels,
      agentPrompts,
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.agentType ? { agentType: opts.agentType } : {}),
    }
    if (phaseIndex === -1) {
      phases.push(phaseSpec)
    } else {
      phases[phaseIndex] = {
        ...phases[phaseIndex],
        ...phaseSpec,
        dependsOn: phases[phaseIndex]?.dependsOn ?? phaseSpec.dependsOn,
      }
    }
  }

  const globals = {
    args,
    Date: Object.assign(WorkflowDate, { now: WorkflowDate, parse: Date.parse, UTC: Date.UTC }),
    Math: createWorkflowMath(),
    URL,
    budget: {
      total: budgetTotal,
      spent: () => spent,
      remaining: () => (budgetTotal === null ? Infinity : Math.max(0, budgetTotal - spent)),
    },
    phase(title: string): void {
      currentPhase = title
      ensurePhasePlaceholder(title)
    },
    log(message: string): void {
      log?.(message)
    },
    async agent(
      prompt: string,
      opts?: WorkflowRuntimeAgentOptions,
    ): Promise<WorkflowRuntimeAgentResult> {
      if (budgetTotal !== null && spent >= budgetTotal) {
        throw new Error('WorkflowBudgetExceededError')
      }
      const label = nextLabel(opts)
      callIndex += 1
      spent += 1
      if (opts?.phase) {
        upsertGroupedAgentPhase({ phaseId: opts.phase, label, prompt, opts })
      } else {
        if (currentPhase) removePhasePlaceholder(currentPhase)
        const phaseIndex = phases.findIndex(phase => phase.id === label)
        const phaseSpec = {
          id: label,
          description: label,
          prompt,
          displayName: label,
          agentLabels: [label],
          agentPrompts: [prompt],
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.agentType ? { agentType: opts.agentType } : {}),
        }
        if (phaseIndex === -1) {
          phases.push(phaseSpec)
        } else {
          phases[phaseIndex] = phaseSpec
        }
        lastGroupedPhaseId = label
      }
      return (placeholderForSchema(opts?.schema, label) ?? {
        label,
        output: `{{agent:${label}}}`,
      }) as WorkflowRuntimeAgentResult
    },
    async parallel<T>(thunks: Array<() => Promise<T> | T>): Promise<Array<T | null>> {
      return Promise.all(
        thunks.map(async thunk => {
          try {
            return await thunk()
          } catch {
            return null
          }
        }),
      )
    },
    async pipeline<T>(items: T[], ...stages: PipelineStage[]): Promise<any[]> {
      const results: any[] = []
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        let value: unknown = item
        for (const stage of stages) {
          if (value === null) break
          try {
            value = await stage(value, item, index)
          } catch {
            value = null
          }
        }
        results.push(value)
      }
      return results
    },
    async workflow(): Promise<never> {
      throw new Error('workflow() child execution is not available in the plan-building adapter')
    },
    toWorkflowSpec(meta: { name: string; description: string }): WorkflowSpec {
      return {
        name: meta.name,
        description: meta.description,
        phases,
        runtime: { kind: 'javascript-worker', isolated: true },
      }
    },
  }

  return globals
}
