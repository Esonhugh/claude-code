import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import type { WorkflowAgentResult } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { isENOENT } from '../../utils/errors.js'
import * as lockfile from '../../utils/lockfile.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
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
  /** The Claude session that started the run; /workflows lists only the current session's. */
  sessionId?: string
  status: 'running' | 'paused' | 'completed' | 'failed' | 'killed'
  runArgs?: WorkflowArgs
  scriptPath?: string
  /** Directory of the run's journal.jsonl and agent transcripts. */
  transcriptDir: string
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

// Runs live where official 2.1.303 keeps them, so either binary can resume the other's:
//   <projects>/<project>/<session>/workflows/<runId>.json              run record
//   <projects>/<project>/<session>/workflows/scripts/<name>-<runId>.js persisted inline script
//   <projects>/<project>/<session>/subagents/workflows/<runId>/        journal.jsonl, agent transcripts
function workflowProjectDir(cwd: string): string {
  return getProjectDir(resolve(cwd))
}

export function workflowSessionDir(cwd: string): string {
  return join(workflowProjectDir(cwd), getSessionId())
}

function workflowRunRecordPath(sessionDir: string, workflowRunId: string): string {
  return join(sessionDir, 'workflows', `${workflowRunId}.json`)
}

function workflowJournalDir(sessionDir: string, workflowRunId: string): string {
  return join(sessionDir, 'subagents', 'workflows', workflowRunId)
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (isENOENT(error)) return undefined
    throw error
  }
}

async function listSessionDirs(cwd: string): Promise<string[]> {
  const projectDir = workflowProjectDir(cwd)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(projectDir, { withFileTypes: true })
  } catch (error) {
    if (isENOENT(error)) return []
    throw error
  }
  return entries.filter(entry => entry.isDirectory()).map(entry => join(projectDir, entry.name))
}

// The session directory holding a run: the current session's unless another session of this
// project already recorded the run id (a resume keeps the id).
async function locateWorkflowRunSessionDir(cwd: string, workflowRunId: string): Promise<string> {
  const current = workflowSessionDir(cwd)
  if (await readJsonFile(workflowRunRecordPath(current, workflowRunId)) !== undefined) return current
  for (const sessionDir of await listSessionDirs(cwd)) {
    if (sessionDir === current) continue
    if (await readJsonFile(workflowRunRecordPath(sessionDir, workflowRunId)) !== undefined) return sessionDir
  }
  return current
}

type OfficialWorkflowRun = {
  runId: string
  taskId?: string
  script?: string
  scriptPath?: string
  agentCount?: number
  durationMs?: number
  summary?: string
  workflowName?: string
  status?: string
  startTime?: number
  phases?: WorkflowScriptMeta['phases']
  totalTokens?: number
  totalToolCalls?: number
  error?: string
}

function officialStatus(status: string | undefined): WorkflowRunSession['status'] {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'paused') return 'paused'
  if (status === 'killed') return 'killed'
  return 'running'
}

function officialWorkflowRunToSession(run: OfficialWorkflowRun, sessionDir: string): WorkflowRunSession {
  const startedAt = run.startTime ?? Date.now()
  return {
    taskId: run.taskId ?? run.runId,
    workflowRunId: run.runId,
    workflowName: run.workflowName ?? run.summary ?? run.runId,
    sessionId: basename(sessionDir),
    status: officialStatus(run.status),
    scriptPath: run.scriptPath,
    transcriptDir: workflowJournalDir(sessionDir, run.runId),
    resumeCacheEntries: [],
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
    error: run.error,
    agentCount: run.agentCount,
    tokenCount: run.totalTokens,
    toolUseCount: run.totalToolCalls,
  }
}

// A record this build wrote carries workflowRunId; anything else is an official run record.
function parseWorkflowRunRecord(record: unknown, sessionDir: string): WorkflowRunSession | undefined {
  if (!record || typeof record !== 'object') return undefined
  if (typeof (record as WorkflowRunSession).workflowRunId === 'string') return record as WorkflowRunSession
  if (typeof (record as OfficialWorkflowRun).runId !== 'string') return undefined
  return officialWorkflowRunToSession(record as OfficialWorkflowRun, sessionDir)
}

// The record is written with official's keys on top, so an official reader sees a run record.
function workflowRunRecord(session: WorkflowRunSession): Record<string, unknown> {
  return {
    ...session,
    runId: session.workflowRunId,
    timestamp: new Date(session.updatedAt).toISOString(),
    script: session.runScriptSnapshot,
    agentCount: session.agentCount,
    durationMs: session.updatedAt - session.startedAt,
    summary: session.meta?.description,
    startTime: session.startedAt,
    phases: session.meta?.phases,
    totalTokens: session.tokenCount,
    totalToolCalls: session.toolUseCount,
  }
}

const workflowRunSessionMutationQueues = new Map<string, Promise<void>>()
const WORKFLOW_RUN_SESSION_LOCK_OPTIONS = {
  stale: 5_000,
  retries: {
    retries: 100,
    minTimeout: 5,
    maxTimeout: 100,
  },
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
  mutation: (latest: WorkflowRunSession | undefined, sessionDir: string) => WorkflowRunSession | undefined,
): Promise<WorkflowRunSession | undefined> {
  const queueKey = `${workflowProjectDir(cwd)}\0${workflowRunId}`
  const previous = workflowRunSessionMutationQueues.get(queueKey) ?? Promise.resolve()
  let updated: WorkflowRunSession | undefined
  const current = previous.catch(() => undefined).then(async () => {
    const sessionDir = await locateWorkflowRunSessionDir(cwd, workflowRunId)
    const lockDir = workflowJournalDir(sessionDir, workflowRunId)
    await mkdir(lockDir, { recursive: true })
    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(lockDir, WORKFLOW_RUN_SESSION_LOCK_OPTIONS)
      const recordPath = workflowRunRecordPath(sessionDir, workflowRunId)
      const latest = parseWorkflowRunRecord(await readJsonFile(recordPath), sessionDir)
      updated = mutation(latest, sessionDir)
      if (!updated || updated === latest) return
      await mkdir(dirname(recordPath), { recursive: true })
      await writeFile(recordPath, `${JSON.stringify(workflowRunRecord(updated), null, 2)}\n`)
    } finally {
      await release?.()
    }
  })
  workflowRunSessionMutationQueues.set(queueKey, current)
  try {
    await current
    return updated
  } finally {
    if (workflowRunSessionMutationQueues.get(queueKey) === current) {
      workflowRunSessionMutationQueues.delete(queueKey)
    }
  }
}

type StartWorkflowRunSessionInput = {
  cwd: string
  taskId: string
  workflowRunId: string
  plan: WorkflowDryRunPlan
  runArgs?: WorkflowArgs
  scriptPath?: string
  resumeFromRunId?: string
}

export async function tryStartWorkflowRunSession({
  cwd,
  taskId,
  workflowRunId,
  plan,
  runArgs,
  scriptPath,
  resumeFromRunId,
}: StartWorkflowRunSessionInput): Promise<{
  session: WorkflowRunSession
  started: boolean
}> {
  let didStart = false
  const session = await mutateWorkflowRunSession(cwd, workflowRunId, (latest, sessionDir) => {
    // Like official, a resume keeps the run id; the caller has already refused a live run.
    if (latest && resumeFromRunId !== workflowRunId) return latest
    didStart = true
    const now = Date.now()
    return {
      taskId,
      workflowRunId,
      workflowName: plan.name,
      sessionId: getSessionId(),
      status: 'running' as const,
      runArgs,
      scriptPath,
      transcriptDir: workflowJournalDir(sessionDir, workflowRunId),
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
  return { session: session!, started: didStart }
}

export async function startWorkflowRunSession(
  input: StartWorkflowRunSessionInput,
): Promise<WorkflowRunSession> {
  return (await tryStartWorkflowRunSession(input)).session
}

export async function listWorkflowRunSessions(
  cwd: string,
): Promise<WorkflowRunSession[]> {
  const byRunId = new Map<string, WorkflowRunSession>()
  for (const sessionDir of await listSessionDirs(cwd)) {
    let names: string[]
    try {
      names = await readdir(join(sessionDir, 'workflows'))
    } catch (error) {
      if (isENOENT(error)) continue
      throw error
    }
    const sessions = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
      try {
        return parseWorkflowRunRecord(await readJsonFile(join(sessionDir, 'workflows', name)), sessionDir)
      } catch {
        return undefined
      }
    }))
    for (const session of sessions) {
      if (!session) continue
      const existing = byRunId.get(session.workflowRunId)
      if (!existing || session.updatedAt > existing.updatedAt) {
        byRunId.set(session.workflowRunId, session)
      }
    }
  }
  return [...byRunId.values()].sort((a, b) => b.startedAt - a.startedAt)
}

export async function loadWorkflowRunSession({
  cwd,
  workflowRunId,
}: {
  cwd: string
  workflowRunId: string
}): Promise<WorkflowRunSession | undefined> {
  const sessionDir = await locateWorkflowRunSessionDir(cwd, workflowRunId)
  return parseWorkflowRunRecord(await readJsonFile(workflowRunRecordPath(sessionDir, workflowRunId)), sessionDir)
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
    if (isTerminalWorkflowRunStatus(base.status)) return base
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
    if (isTerminalWorkflowRunStatus(base.status)) return base
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
