import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { WorkflowAgentResult } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type {
  WorkflowArgs,
  WorkflowDryRunPlan,
  WorkflowProgressEvent,
} from './workflowSpec.js'
import { createWorkflowScriptAgentIdentity, type WorkflowResumeCacheEntry } from './workflowResumeCache.js'
import type { WorkflowScriptMeta } from './workflowScriptParser.js'

export type WorkflowRunSession = {
  taskId: string
  workflowRunId: string
  workflowName: string
  status: 'running' | 'paused' | 'completed' | 'failed' | 'killed'
  runArgs?: WorkflowArgs
  scriptPath?: string
  transcriptDir?: string
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

export function officialProjectDirName(cwd: string): string {
  return `-${cwd.replace(/^\/+/, '').replace(/\/+$/g, '').replace(/\//g, '-')}`
}

function officialWorkflowProjectRoot(cwd: string, projectsRoot?: string): string {
  return join(projectsRoot ?? join(homedir(), '.claude', 'projects'), officialProjectDirName(cwd))
}

type OfficialWorkflowRun = {
  runId: string
  taskId?: string
  script?: string
  scriptPath?: string
  result?: unknown
  agentCount?: number
  logs?: string[]
  durationMs?: number
  summary?: string
  workflowName?: string
  status?: string
  startTime?: number
  phases?: WorkflowScriptMeta['phases']
  workflowProgress?: Array<{
    type?: string
    index?: number
    label?: string
    phaseTitle?: string
    resultPreview?: string
    promptPreview?: string
  }>
  totalTokens?: number
  totalToolCalls?: number
}

function workflowArgsFromOfficialResult(result: unknown): WorkflowArgs | undefined {
  if (
    typeof result === 'string' ||
    typeof result === 'number' ||
    typeof result === 'boolean' ||
    result === null ||
    Array.isArray(result) ||
    typeof result === 'object'
  ) {
    return result as WorkflowArgs
  }
  return undefined
}

function officialWorkflowResumeEntries(run: OfficialWorkflowRun): WorkflowResumeCacheEntry[] {
  const progress = run.workflowProgress ?? []
  const agents = progress.filter(item => item.type === 'workflow_agent')
  return agents.flatMap((agent, agentIndex): WorkflowResumeCacheEntry[] => {
    if (!agent.promptPreview) return []
    const label = agent.label ?? agent.promptPreview
    const result = agent.resultPreview ?? (
      agents.length === 1 && run.result && typeof run.result === 'object' && label in run.result
        ? (run.result as Record<string, unknown>)[label]
        : undefined
    )
    if (result === undefined) return []
    return [{
      index: typeof agent.index === 'number' ? Math.max(0, agent.index - 1) : agentIndex,
      identity: createWorkflowScriptAgentIdentity(agent.promptPreview, { label }),
      phase: agent.phaseTitle,
      label,
      result,
      completedAt: run.startTime ?? Date.now(),
    }]
  })
}

function officialWorkflowRunToSession(run: OfficialWorkflowRun): WorkflowRunSession {
  const now = Date.now()
  const startedAt = run.startTime ?? now
  return {
    taskId: run.taskId ?? run.runId,
    workflowRunId: run.runId,
    workflowName: run.workflowName ?? run.summary ?? run.runId,
    status: run.status === 'completed' ? 'completed' : run.status === 'failed' ? 'failed' : 'running',
    runArgs: workflowArgsFromOfficialResult(run.result),
    scriptPath: run.scriptPath,
    resumeCacheEntries: officialWorkflowResumeEntries(run),
    meta: run.workflowName && run.summary ? {
      name: run.workflowName,
      description: run.summary,
      phases: run.phases ?? [],
    } : undefined,
    runScriptSnapshot: run.script,
    startedAt,
    updatedAt: startedAt + (run.durationMs ?? 0),
    results: [],
    events: [],
  }
}

async function loadOfficialWorkflowRunSession({
  cwd,
  workflowRunId,
  projectsRoot,
}: {
  cwd: string
  workflowRunId: string
  projectsRoot?: string
}): Promise<WorkflowRunSession | undefined> {
  const projectRoot = officialWorkflowProjectRoot(cwd, projectsRoot)
  async function scan(dir: string): Promise<WorkflowRunSession | undefined> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = await scan(path)
        if (found) return found
        continue
      }
      if (entry.name !== `${workflowRunId}.json`) continue
      try {
        return officialWorkflowRunToSession(JSON.parse(await readFile(path, 'utf8')) as OfficialWorkflowRun)
      } catch {
        return undefined
      }
    }
    return undefined
  }
  return scan(projectRoot)
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
  transcriptDir,
  resumeFromRunId,
}: {
  cwd: string
  taskId: string
  workflowRunId: string
  plan: WorkflowDryRunPlan
  runArgs?: WorkflowArgs
  scriptPath?: string
  transcriptDir?: string
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
    transcriptDir,
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
  projectsRoot,
}: {
  cwd: string
  workflowRunId: string
  projectsRoot?: string
}): Promise<WorkflowRunSession | undefined> {
  try {
    return JSON.parse(await readFile(runSessionPath(cwd, workflowRunId), 'utf8')) as WorkflowRunSession
  } catch {
    return loadOfficialWorkflowRunSession({ cwd, workflowRunId, projectsRoot })
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
