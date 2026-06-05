import type { WorkflowPhaseSpec, WorkflowSpec } from './workflowSpec.js'

export type WorkflowAgentRequest = {
  label: string
  prompt: string
  dependsOn?: string[]
  review?: WorkflowPhaseSpec['review']
}

export type WorkflowAgentOutput = {
  label: string
  output: string
}

type LoopUntilInput<T> = {
  label: string
  maxIterations: number
  run: (iteration: number) => Promise<T>
  isDone: (result: T) => boolean
}

export function createWorkflowOrchestrator({
  workflowRunId,
  maxAgents,
}: {
  workflowRunId: string
  maxAgents: number
}) {
  const phases: WorkflowPhaseSpec[] = []
  const logs: string[] = []

  function assertAgentBudget(): void {
    if (phases.length >= maxAgents) {
      throw new Error(`Workflow agent budget exceeded: ${maxAgents}`)
    }
  }

  const orchestrator = {
    agent(request: WorkflowAgentRequest): Promise<WorkflowAgentOutput> {
      assertAgentBudget()
      phases.push({
        id: request.label,
        description: request.label,
        prompt: request.prompt,
        dependsOn: request.dependsOn,
        review: request.review,
      })
      return Promise.resolve({
        label: request.label,
        output: `{{agent:${request.label}}}`,
      })
    },

    parallel<T>(items: Array<Promise<T>>): Promise<T[]> {
      return Promise.all(items)
    },

    async series<T>(items: Array<() => Promise<T>>): Promise<T[]> {
      const results: T[] = []
      for (const item of items) {
        results.push(await item())
      }
      return results
    },

    async retry<T>({
      attempts,
      run,
    }: {
      attempts: number
      run: (attempt: number) => Promise<T>
    }): Promise<T> {
      let lastError: unknown
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await run(attempt)
        } catch (error) {
          lastError = error
        }
      }
      throw lastError
    },

    async loopUntil<T>({
      maxIterations,
      run,
      isDone,
    }: LoopUntilInput<T>): Promise<T> {
      let lastResult: T | undefined
      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        lastResult = await run(iteration)
        if (isDone(lastResult)) return lastResult
      }
      return lastResult as T
    },

    review(request: Omit<WorkflowAgentRequest, 'review'>): Promise<WorkflowAgentOutput> {
      return orchestrator.agent({ ...request, review: 'cross-check' })
    },

    refute(request: Omit<WorkflowAgentRequest, 'review'>): Promise<WorkflowAgentOutput> {
      return orchestrator.agent({ ...request, review: 'adversarial' })
    },

    synthesize(request: Omit<WorkflowAgentRequest, 'review'>): Promise<WorkflowAgentOutput> {
      return orchestrator.agent({ ...request, review: 'synthesis' })
    },

    vote(request: Omit<WorkflowAgentRequest, 'review'>): Promise<WorkflowAgentOutput> {
      return orchestrator.agent({ ...request, review: 'synthesis' })
    },

    log(message: string): void {
      logs.push(message)
    },

    toSpec(): WorkflowSpec & { orchestrationLogs: string[] } {
      return {
        name: workflowRunId,
        description: `Workflow orchestration plan ${workflowRunId}`,
        phases,
        orchestrationLogs: logs,
      }
    },
  }

  return orchestrator
}
