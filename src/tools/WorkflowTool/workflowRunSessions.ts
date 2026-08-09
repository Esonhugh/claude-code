import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { WorkflowAgentResult } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { isENOENT } from '../../utils/errors.js'
import type {
  WorkflowArgs,
  WorkflowDryRunPlan,
  WorkflowProgressEvent,
} from './workflowSpec.js'
import { createWorkflowScriptAgentChainIdentity, type WorkflowResumeCacheEntry } from './workflowResumeCache.js'
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
  agentCount?: number
  tokenCount?: number
  toolUseCount?: number
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
  let previousKey = ''
  return agents.flatMap((agent, agentIndex): WorkflowResumeCacheEntry[] => {
    if (!agent.promptPreview) return []
    const label = agent.label ?? agent.promptPreview
    const result = agent.resultPreview ?? (
      agents.length === 1 && run.result && typeof run.result === 'object' && label in run.result
        ? (run.result as Record<string, unknown>)[label]
        : undefined
    )
    const identity = createWorkflowScriptAgentChainIdentity({
      previousKey,
      prompt: agent.promptPreview,
      opts: {
        label,
        phase: agent.phaseTitle,
      },
    })
    previousKey = identity
    if (result === undefined) return []
    return [{
      index: typeof agent.index === 'number' ? Math.max(0, agent.index - 1) : agentIndex,
      identity,
      phase: agent.phaseTitle,
      label,
      result,
      completedAt: run.startTime ?? Date.now(),
    }]
  })
}

function officialStatus(status: string | undefined): WorkflowRunSession['status'] {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'paused') return 'paused'
  if (status === 'killed') return 'killed'
  return 'running'
}

function officialWorkflowRunToSession(run: OfficialWorkflowRun): WorkflowRunSession {
  const now = Date.now()
  const startedAt = run.startTime ?? now
  return {
    taskId: run.taskId ?? run.runId,
    workflowRunId: run.runId,
    workflowName: run.workflowName ?? run.summary ?? run.runId,
    status: officialStatus(run.status),
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
    agentCount: run.agentCount,
    tokenCount: run.totalTokens,
    toolUseCount: run.totalToolCalls,
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

const workflowRunSessionMutationQueues = new Map<string, Promise<void>>()

type WorkflowRunSessionMutation = (
  latest: WorkflowRunSession | undefined,
) => WorkflowRunSession | undefined

function workflowRunSessionMutationKey(cwd: string, workflowRunId: string): string {
  return `${cwd}\0${workflowRunId}`
}

function maxWorkflowRunSessionCount(
  current: number | undefined,
  next: number | undefined,
): number | undefined {
  if (next === undefined) return current
  if (current === undefined) return next
  return Math.max(current, next)
}

function isTerminalWorkflowRunStatus(status: WorkflowRunSession['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

async function mutateWorkflowRunSession(
  cwd: string,
  workflowRunId: string,
  mutation: WorkflowRunSessionMutation,
): Promise<WorkflowRunSession | undefined> {
  const key = workflowRunSessionMutationKey(cwd, workflowRunId)
  const previous = workflowRunSessionMutationQueues.get(key) ?? Promise.resolve()
  let updated: WorkflowRunSession | undefined
  const current = previous.catch(() => undefined).then(async () => {
    const latest = await loadWorkflowRunSession({
      cwd,
      workflowRunId,
      includeOfficialFallback: false,
    })
    updated = mutation(latest)
    if (!updated) return
    await writeWorkflowRunSession(cwd, updated)
  })
  workflowRunSessionMutationQueues.set(key, current)
  try {
    await current
    return updated
  } finally {
    if (workflowRunSessionMutationQueues.get(key) === current) {
      workflowRunSessionMutationQueues.delete(key)
    }
  }
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
  const started = await mutateWorkflowRunSession(cwd, workflowRunId, () => {
    const now = Date.now()
    return {
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
      ...(plan.totalAgents > 0 ? { agentCount: plan.totalAgents } : {}),
    }
  })
  return started!
}

export async function listWorkflowRunSessions(
  cwd: string,
): Promise<WorkflowRunSession[]> {
  const root = join(cwd, '.claude', 'workflow-runs')
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const sessions = await Promise.all(entries.map(async entry => {
    const path = entry.isDirectory()
      ? join(root, entry.name, 'session.json')
      : entry.isFile() && entry.name.endsWith('.json')
        ? join(root, entry.name)
        : undefined
    if (!path) return undefined
    try {
      return JSON.parse(await readFile(path, 'utf8')) as WorkflowRunSession
    } catch {
      return undefined
    }
  }))

  const byRunId = new Map<string, WorkflowRunSession>()
  for (const session of sessions) {
    if (!session?.workflowRunId) continue
    const existing = byRunId.get(session.workflowRunId)
    if (!existing || session.updatedAt > existing.updatedAt) {
      byRunId.set(session.workflowRunId, session)
    }
  }
  return [...byRunId.values()].sort((a, b) => b.startedAt - a.startedAt)
}

export async function loadWorkflowRunSession({
  cwd,
  workflowRunId,
  projectsRoot,
  includeOfficialFallback = true,
}: {
  cwd: string
  workflowRunId: string
  projectsRoot?: string
  includeOfficialFallback?: boolean
}): Promise<WorkflowRunSession | undefined> {
  try {
    return JSON.parse(await readFile(runSessionPath(cwd, workflowRunId), 'utf8')) as WorkflowRunSession
  } catch (error) {
    if (!isENOENT(error)) throw error
    if (!includeOfficialFallback) return undefined
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
  const updated = await mutateWorkflowRunSession(cwd, session.workflowRunId, latest => {
    const base = latest ?? session
    return {
      ...base,
      updatedAt: Date.now(),
      events: [...base.events, event],
    }
  })
  return updated!
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
  return mutateWorkflowRunSession(cwd, workflowRunId, session => {
    if (!session || isTerminalWorkflowRunStatus(session.status)) return session
    return {
      ...session,
      status,
      updatedAt: Date.now(),
      events: event ? [...session.events, event] : session.events,
      ...(resumePrompt !== undefined ? { resumePrompt } : {}),
    }
  })
}

export async function updateWorkflowRunSessionProgress({
  cwd,
  session,
  results,
  resumeCacheEntries = session.resumeCacheEntries,
  agentCount = session.agentCount,
  tokenCount = session.tokenCount,
  toolUseCount = session.toolUseCount,
}: {
  cwd: string
  session: WorkflowRunSession
  results: WorkflowAgentResult[]
  resumeCacheEntries?: WorkflowResumeCacheEntry[]
  agentCount?: number
  tokenCount?: number
  toolUseCount?: number
}): Promise<WorkflowRunSession> {
  const updated = await mutateWorkflowRunSession(cwd, session.workflowRunId, latest => {
    const base = latest ?? session
    const agentTotal = maxWorkflowRunSessionCount(base.agentCount, agentCount)
    const tokenTotal = maxWorkflowRunSessionCount(base.tokenCount, tokenCount)
    const toolUseTotal = maxWorkflowRunSessionCount(base.toolUseCount, toolUseCount)
    return {
      ...base,
      updatedAt: Date.now(),
      ...(isTerminalWorkflowRunStatus(base.status) ? {} : { results, resumeCacheEntries }),
      ...(agentTotal !== undefined ? { agentCount: agentTotal } : {}),
      ...(tokenTotal !== undefined ? { tokenCount: tokenTotal } : {}),
      ...(toolUseTotal !== undefined ? { toolUseCount: toolUseTotal } : {}),
    }
  })
  return updated!
}

export async function completeWorkflowRunSession({
  cwd,
  session,
  results,
  resumeCacheEntries = session.resumeCacheEntries,
  agentCount = session.agentCount,
  tokenCount = session.tokenCount,
  toolUseCount = session.toolUseCount,
}: {
  cwd: string
  session: WorkflowRunSession
  results: WorkflowAgentResult[]
  resumeCacheEntries?: WorkflowResumeCacheEntry[]
  agentCount?: number
  tokenCount?: number
  toolUseCount?: number
}): Promise<void> {
  await mutateWorkflowRunSession(cwd, session.workflowRunId, latest => {
    const base = latest ?? session
    const agentTotal = maxWorkflowRunSessionCount(base.agentCount, agentCount)
    const tokenTotal = maxWorkflowRunSessionCount(base.tokenCount, tokenCount)
    const toolUseTotal = maxWorkflowRunSessionCount(base.toolUseCount, toolUseCount)
    return {
      ...base,
      status: 'completed',
      updatedAt: Date.now(),
      results,
      resumeCacheEntries,
      ...(agentTotal !== undefined ? { agentCount: agentTotal } : {}),
      ...(tokenTotal !== undefined ? { tokenCount: tokenTotal } : {}),
      ...(toolUseTotal !== undefined ? { toolUseCount: toolUseTotal } : {}),
      error: undefined,
    }
  })
}

export async function failWorkflowRunSession({
  cwd,
  session,
  results,
  error,
  resumeCacheEntries = session.resumeCacheEntries,
  agentCount = session.agentCount,
  tokenCount = session.tokenCount,
  toolUseCount = session.toolUseCount,
}: {
  cwd: string
  session: WorkflowRunSession
  results: WorkflowAgentResult[]
  error: string
  resumeCacheEntries?: WorkflowResumeCacheEntry[]
  agentCount?: number
  tokenCount?: number
  toolUseCount?: number
}): Promise<void> {
  await mutateWorkflowRunSession(cwd, session.workflowRunId, latest => {
    const base = latest ?? session
    const agentTotal = maxWorkflowRunSessionCount(base.agentCount, agentCount)
    const tokenTotal = maxWorkflowRunSessionCount(base.tokenCount, tokenCount)
    const toolUseTotal = maxWorkflowRunSessionCount(base.toolUseCount, toolUseCount)
    return {
      ...base,
      status: 'failed',
      updatedAt: Date.now(),
      results,
      resumeCacheEntries,
      ...(agentTotal !== undefined ? { agentCount: agentTotal } : {}),
      ...(tokenTotal !== undefined ? { tokenCount: tokenTotal } : {}),
      ...(toolUseTotal !== undefined ? { toolUseCount: toolUseTotal } : {}),
      error,
    }
  })
}
