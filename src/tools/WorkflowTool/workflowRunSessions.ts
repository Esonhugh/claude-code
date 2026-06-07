import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WorkflowAgentResult } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type {
  WorkflowArgs,
  WorkflowDryRunPlan,
  WorkflowProgressEvent,
} from './workflowSpec.js'
import type { WorkflowResumeCacheEntry } from './workflowResumeCache.js'
import type { WorkflowScriptMeta } from './workflowScriptParser.js'

export type WorkflowRunSession = {
  taskId: string
  workflowRunId: string
  workflowName: string
  status: 'running' | 'paused' | 'completed' | 'failed' | 'killed'
  runArgs?: WorkflowArgs
  scriptPath?: string
  resumeFromRunId?: string
  meta?: WorkflowScriptMeta
  resumeCacheEntries: WorkflowResumeCacheEntry[]
  runtime?: WorkflowDryRunPlan['runtime']
  sourcePath?: string
  runScriptSnapshot?: string
  startedAt: number
  updatedAt: number
  results: WorkflowAgentResult[]
  events: WorkflowProgressEvent[]
  resumePrompt?: string
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
    meta: plan.meta,
    resumeCacheEntries: [],
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

export async function loadWorkflowRunSession({
  cwd,
  workflowRunId,
}: {
  cwd: string
  workflowRunId: string
}): Promise<WorkflowRunSession | undefined> {
  try {
    return JSON.parse(await readFile(runSessionPath(cwd, workflowRunId), 'utf8')) as WorkflowRunSession
  } catch {
    return undefined
  }
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

export async function updateWorkflowRunSessionStatus({
  cwd,
  workflowRunId,
  status,
  event,
  resumePrompt,
}: {
  cwd: string
  workflowRunId: string
  status: WorkflowRunSession['status']
  event?: WorkflowProgressEvent
  resumePrompt?: string
}): Promise<WorkflowRunSession | undefined> {
  const session = await loadWorkflowRunSession({ cwd, workflowRunId })
  if (!session) return undefined
  const updated = {
    ...session,
    status,
    updatedAt: Date.now(),
    events: event ? [...session.events, event] : session.events,
    ...(resumePrompt !== undefined ? { resumePrompt } : {}),
  }
  await writeWorkflowRunSession(cwd, updated)
  return updated
}

export async function updateWorkflowRunSessionProgress({
  cwd,
  session,
  results,
  resumeCacheEntries = session.resumeCacheEntries,
}: {
  cwd: string
  session: WorkflowRunSession
  results: WorkflowAgentResult[]
  resumeCacheEntries?: WorkflowResumeCacheEntry[]
}): Promise<WorkflowRunSession> {
  const updated = {
    ...session,
    updatedAt: Date.now(),
    results,
    resumeCacheEntries,
  }
  await writeWorkflowRunSession(cwd, updated)
  return updated
}

export async function completeWorkflowRunSession({
  cwd,
  session,
  results,
  resumeCacheEntries = session.resumeCacheEntries,
}: {
  cwd: string
  session: WorkflowRunSession
  results: WorkflowAgentResult[]
  resumeCacheEntries?: WorkflowResumeCacheEntry[]
}): Promise<void> {
  await writeWorkflowRunSession(cwd, {
    ...session,
    status: 'completed',
    updatedAt: Date.now(),
    results,
    resumeCacheEntries,
    error: undefined,
  })
}

export async function failWorkflowRunSession({
  cwd,
  session,
  results,
  error,
  resumeCacheEntries = session.resumeCacheEntries,
}: {
  cwd: string
  session: WorkflowRunSession
  results: WorkflowAgentResult[]
  error: string
  resumeCacheEntries?: WorkflowResumeCacheEntry[]
}): Promise<void> {
  await writeWorkflowRunSession(cwd, {
    ...session,
    status: 'failed',
    updatedAt: Date.now(),
    results,
    resumeCacheEntries,
    error,
  })
}
