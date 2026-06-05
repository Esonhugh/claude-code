import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WorkflowAgentResult } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type {
  WorkflowArgs,
  WorkflowDryRunPlan,
  WorkflowProgressEvent,
} from './workflowSpec.js'

export type WorkflowRunSession = {
  taskId: string
  workflowRunId: string
  workflowName: string
  status: 'running' | 'completed' | 'failed'
  runArgs?: WorkflowArgs
  scriptPath?: string
  resumeFromRunId?: string
  runtime?: WorkflowDryRunPlan['runtime']
  sourcePath?: string
  runScriptSnapshot?: string
  startedAt: number
  updatedAt: number
  results: WorkflowAgentResult[]
  events: WorkflowProgressEvent[]
  error?: string
}

function taskSessionPath(cwd: string, taskId: string): string {
  return join(cwd, '.claude', 'workflow-runs', `${taskId}.json`)
}

function runSessionPath(cwd: string, workflowRunId: string): string {
  return join(cwd, '.claude', 'workflow-runs', workflowRunId, 'session.json')
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeWorkflowRunSession(cwd: string, session: WorkflowRunSession): Promise<void> {
  await writeJson(taskSessionPath(cwd, session.taskId), session)
  await writeJson(runSessionPath(cwd, session.workflowRunId), session)
}

export async function startWorkflowRunSession({
  cwd,
  taskId,
  workflowRunId,
  plan,
  runArgs,
  scriptPath,
  resumeFromRunId,
}: {
  cwd: string
  taskId: string
  workflowRunId: string
  plan: WorkflowDryRunPlan
  runArgs?: WorkflowArgs
  scriptPath?: string
  resumeFromRunId?: string
}): Promise<WorkflowRunSession> {
  const now = Date.now()
  const session = {
    taskId,
    workflowRunId,
    workflowName: plan.name,
    status: 'running' as const,
    runArgs,
    scriptPath,
    resumeFromRunId,
    runtime: plan.runtime,
    sourcePath: plan.sourcePath,
    runScriptSnapshot: plan.runScriptSnapshot,
    startedAt: now,
    updatedAt: now,
    results: [],
    events: [],
  }
  await writeWorkflowRunSession(cwd, session)
  return session
}

export async function appendWorkflowRunEvent({
  cwd,
  session,
  event,
}: {
  cwd: string
  session: WorkflowRunSession
  event: WorkflowProgressEvent
}): Promise<WorkflowRunSession> {
  const updated = {
    ...session,
    updatedAt: Date.now(),
    events: [...session.events, event],
  }
  await writeWorkflowRunSession(cwd, updated)
  return updated
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
