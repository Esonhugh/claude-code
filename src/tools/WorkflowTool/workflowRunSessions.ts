import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WorkflowAgentResult } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { WorkflowDryRunPlan } from './workflowSpec.js'

export type WorkflowRunSession = {
  taskId: string
  workflowName: string
  status: 'running' | 'completed' | 'failed'
  runArgs: string
  runtime?: WorkflowDryRunPlan['runtime']
  sourcePath?: string
  runScriptSnapshot?: string
  startedAt: number
  updatedAt: number
  results: WorkflowAgentResult[]
  error?: string
}

function sessionPath(cwd: string, taskId: string): string {
  return join(cwd, '.claude', 'workflow-runs', `${taskId}.json`)
}

async function writeWorkflowRunSession(cwd: string, session: WorkflowRunSession): Promise<void> {
  const path = sessionPath(cwd, session.taskId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`)
}

export async function startWorkflowRunSession({
  cwd,
  taskId,
  plan,
  runArgs,
}: {
  cwd: string
  taskId: string
  plan: WorkflowDryRunPlan
  runArgs?: string
}): Promise<WorkflowRunSession> {
  const now = Date.now()
  const session = {
    taskId,
    workflowName: plan.name,
    status: 'running' as const,
    runArgs: runArgs?.trim() ?? '',
    runtime: plan.runtime,
    sourcePath: plan.sourcePath,
    runScriptSnapshot: plan.runScriptSnapshot,
    startedAt: now,
    updatedAt: now,
    results: [],
  }
  await writeWorkflowRunSession(cwd, session)
  return session
}

export async function completeWorkflowRunSession({
  cwd,
  session,
  results,
}: {
  cwd: string
  session: WorkflowRunSession
  results: WorkflowAgentResult[]
}): Promise<void> {
  await writeWorkflowRunSession(cwd, {
    ...session,
    status: 'completed',
    updatedAt: Date.now(),
    results,
    error: undefined,
  })
}

export async function failWorkflowRunSession({
  cwd,
  session,
  results,
  error,
}: {
  cwd: string
  session: WorkflowRunSession
  results: WorkflowAgentResult[]
  error: string
}): Promise<void> {
  await writeWorkflowRunSession(cwd, {
    ...session,
    status: 'failed',
    updatedAt: Date.now(),
    results,
    error,
  })
}
