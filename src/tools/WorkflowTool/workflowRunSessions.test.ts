#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { WorkflowAgentResult } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { createWorkflowScriptAgentChainIdentity } from './workflowResumeCache.js'
import { createWorkflowRunId } from './workflowScriptPersistence.js'
import {
  appendWorkflowRunEvent,
  completeWorkflowRunSession,
  failWorkflowRunSession,
  listWorkflowRunSessions,
  loadWorkflowRunSession,
  officialProjectDirName,
  startWorkflowRunSession,
  tryStartWorkflowRunSession,
  updateWorkflowRunSessionProgress,
  updateWorkflowRunSessionStatus,
} from './workflowRunSessions.js'

const generatedRunId = createWorkflowRunId()
assert.match(generatedRunId, /^wf_[a-z0-9-]{6,}$/)
assert.equal(generatedRunId.slice(3).includes('_'), false)

const projectsRoot = await mkdtemp(join(tmpdir(), 'official-workflow-projects-'))
const localRoot = await mkdtemp(join(tmpdir(), 'local-workflow-runs-'))
const cwd = '/tmp/example-project'
const officialRunId = 'wf_f73c6180-2aa'
const officialRunDir = join(projectsRoot, officialProjectDirName(cwd), 'official-session', 'workflows')
await mkdir(officialRunDir, { recursive: true })
await writeFile(
  join(officialRunDir, `${officialRunId}.json`),
  `${JSON.stringify({
    runId: officialRunId,
    taskId: 'wofficial1',
    scriptPath: '/tmp/portable-workflow-ok.js',
    script: `export const meta = {
      name: 'portable-workflow-ok',
      description: 'Portable workflow that asks one agent for workflow-ok',
      phases: [{ title: 'Run', detail: 'One agent replies workflow-ok' }],
    }
    phase('Run')
    const reply = await agent('Reply exactly: workflow-ok', { label: 'portable-agent' })
    return { reply }`,
    result: { reply: 'workflow-ok' },
    agentCount: 1,
    logs: [],
    durationMs: 2,
    summary: 'Portable workflow that asks one agent for workflow-ok',
    workflowName: 'portable-workflow-ok',
    status: 'completed',
    startTime: 1783399711654,
    phases: [{ title: 'Run', detail: 'One agent replies workflow-ok' }],
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Run' },
      {
        type: 'workflow_agent',
        index: 1,
        label: 'portable-agent',
        phaseIndex: 1,
        phaseTitle: 'Run',
        agentId: 'a655c8ceb6b5a59d1',
        model: 'gpt-5.5',
        state: 'done',
        cached: true,
        resultPreview: 'workflow-ok',
        promptPreview: 'Reply exactly: workflow-ok',
      },
    ],
    totalTokens: 0,
    totalToolCalls: 0,
  })}\n`,
)

await writeFile(
  join(officialRunDir, 'wf_paused.json'),
  `${JSON.stringify({
    runId: 'wf_paused',
    workflowName: 'paused-workflow',
    summary: 'Paused workflow',
    status: 'paused',
    startTime: 1783399711654,
  })}\n`,
)
await writeFile(
  join(officialRunDir, 'wf_killed.json'),
  `${JSON.stringify({
    runId: 'wf_killed',
    workflowName: 'killed-workflow',
    summary: 'Killed workflow',
    status: 'killed',
    startTime: 1783399711654,
  })}\n`,
)
const pausedSession = await loadWorkflowRunSession({ cwd, workflowRunId: 'wf_paused', projectsRoot })
const killedSession = await loadWorkflowRunSession({ cwd, workflowRunId: 'wf_killed', projectsRoot })
assert.equal(pausedSession?.status, 'paused')
assert.equal(killedSession?.status, 'killed')

const officialSession = await loadWorkflowRunSession({ cwd, workflowRunId: officialRunId, projectsRoot })
assert.ok(officialSession)
assert.equal(officialSession.workflowRunId, officialRunId)
assert.equal(officialSession.workflowName, 'portable-workflow-ok')
assert.equal(officialSession.status, 'completed')
assert.equal(officialSession.scriptPath, '/tmp/portable-workflow-ok.js')
assert.equal(officialSession.agentCount, 1)
assert.equal(officialSession.tokenCount, 0)
assert.equal(officialSession.toolUseCount, 0)
assert.equal(officialSession.resumeCacheEntries.length, 1)
assert.deepEqual(officialSession.resumeCacheEntries[0], {
  index: 0,
  identity: createWorkflowScriptAgentChainIdentity({
    previousKey: '',
    prompt: 'Reply exactly: workflow-ok',
    opts: { label: 'portable-agent', phase: 'Run' },
  }),
  phase: 'Run',
  label: 'portable-agent',
  result: 'workflow-ok',
  completedAt: 1783399711654,
})

const localRunsRoot = join(localRoot, '.claude', 'workflow-runs')
await mkdir(join(localRunsRoot, 'wf_newer'), { recursive: true })
const persistedSession = {
  taskId: 'w-local',
  workflowRunId: 'wf_newer',
  workflowName: 'newer',
  status: 'completed',
  resumeCacheEntries: [],
  startedAt: 20,
  updatedAt: 30,
  results: [],
  events: [],
}
await writeFile(
  join(localRunsRoot, 'wf_newer', 'session.json'),
  `${JSON.stringify(persistedSession)}\n`,
)
await writeFile(
  join(localRunsRoot, 'w-local.json'),
  `${JSON.stringify({ ...persistedSession, updatedAt: 25 })}\n`,
)
await writeFile(
  join(localRunsRoot, 'invalid.json'),
  '{invalid json',
)
await mkdir(join(localRunsRoot, 'wf_older'), { recursive: true })
await writeFile(
  join(localRunsRoot, 'wf_older', 'session.json'),
  `${JSON.stringify({
    ...persistedSession,
    taskId: 'w-older',
    workflowRunId: 'wf_older',
    workflowName: 'older',
    startedAt: 10,
    updatedAt: 15,
  })}\n`,
)
const listedSessions = await listWorkflowRunSessions(localRoot)
assert.deepEqual(listedSessions.map(session => session.workflowRunId), [
  'wf_newer',
  'wf_older',
])
assert.equal(listedSessions[0]?.updatedAt, 30)
assert.deepEqual(await listWorkflowRunSessions(join(localRoot, 'missing')), [])

await mkdir(join(localRunsRoot, 'wf_corrupt'), { recursive: true })
const corruptSessionPath = join(localRunsRoot, 'wf_corrupt', 'session.json')
await writeFile(corruptSessionPath, '{invalid json')
await assert.rejects(
  loadWorkflowRunSession({
    cwd: localRoot,
    workflowRunId: 'wf_corrupt',
    projectsRoot,
  }),
  SyntaxError,
)
assert.equal(await readFile(corruptSessionPath, 'utf8'), '{invalid json')

const staleRoot = await mkdtemp(join(tmpdir(), 'workflow-stale-session-'))
const staleRunId = 'wf_stale_append'
const staleSnapshot = await startWorkflowRunSession({
  cwd: staleRoot,
  taskId: 'w-stale-append',
  workflowRunId: staleRunId,
  plan: {
    name: 'stale-append-workflow',
    description: 'stale append workflow',
    defaults: {
      maxConcurrency: 1,
      maxAgents: 1,
      maxRetries: 0,
      fanout: 1,
      concurrency: 1,
      review: 'none',
      execution: 'agent',
    },
    phases: [],
    totalAgents: 1,
  },
})
const terminalResults = [{
  phaseId: 'phase-1',
  agentId: 'agent-1',
  index: 0,
  status: 'completed' as const,
  output: 'terminal result',
  tokenCount: 123,
  toolUseCount: 4,
}]
const terminalResumeCacheEntries = [{
  index: 0,
  identity: 'terminal-cache-key',
  phase: 'phase-1',
  label: 'agent-1',
  result: 'cached terminal result',
  completedAt: 1783399711660,
}]
await completeWorkflowRunSession({
  cwd: staleRoot,
  session: staleSnapshot,
  results: terminalResults,
  resumeCacheEntries: terminalResumeCacheEntries,
  tokenCount: 123,
  toolUseCount: 4,
})
const staleAppendEvent = {
  type: 'workflow_log' as const,
  workflowRunId: staleRunId,
  message: 'late stale event',
  timestamp: 1783399711661,
}
await appendWorkflowRunEvent({
  cwd: staleRoot,
  session: staleSnapshot,
  event: staleAppendEvent,
})
const staleFinalSession = await loadWorkflowRunSession({ cwd: staleRoot, workflowRunId: staleRunId })
assert.ok(staleFinalSession)
assert.equal(staleFinalSession.status, 'completed')
assert.deepEqual(staleFinalSession.results, terminalResults)
assert.deepEqual(staleFinalSession.resumeCacheEntries, terminalResumeCacheEntries)
assert.equal(staleFinalSession.tokenCount, 123)
assert.equal(staleFinalSession.toolUseCount, 4)
assert.deepEqual(staleFinalSession.events.at(-1), staleAppendEvent)

const concurrentAppendRoot = await mkdtemp(join(tmpdir(), 'workflow-concurrent-append-'))
const concurrentAppendAttempts = 8
const concurrentAppendCount = 48
let concurrentAppendActual = {
  attempt: -1,
  eventCount: 0,
  eventIds: [] as string[],
  missingEventIds: [] as string[],
}
let concurrentAppendExpected = concurrentAppendActual
for (let attempt = 0; attempt < concurrentAppendAttempts; attempt++) {
  const workflowRunId = `wf_concurrent_append_${attempt}`
  const appendSnapshot = await startWorkflowRunSession({
    cwd: concurrentAppendRoot,
    taskId: `w-concurrent-append-${attempt}`,
    workflowRunId,
    plan: {
      name: 'concurrent-append-workflow',
      description: 'concurrent append workflow',
      defaults: {
        maxConcurrency: 1,
        maxAgents: 1,
        maxRetries: 0,
        fanout: 1,
        concurrency: 1,
        review: 'none',
        execution: 'agent',
      },
      phases: [],
      totalAgents: 1,
    },
  })
  const appendEvents = Array.from({ length: concurrentAppendCount }, (_, index) => ({
    type: 'workflow_log' as const,
    workflowRunId,
    message: `concurrent append ${attempt}:${index}`,
    timestamp: 1783399711700 + index,
  }))
  await Promise.all(appendEvents.map(event => appendWorkflowRunEvent({
    cwd: concurrentAppendRoot,
    session: appendSnapshot,
    event,
  })))
  const appendFinalSession = await loadWorkflowRunSession({
    cwd: concurrentAppendRoot,
    workflowRunId,
  })
  assert.ok(appendFinalSession)
  const eventIds = appendFinalSession.events
    .map(event => event.type === 'workflow_log' ? event.message : undefined)
    .filter((message): message is string => typeof message === 'string')
    .sort()
  const expectedEventIds = appendEvents.map(event => event.message).sort()
  concurrentAppendActual = {
    attempt,
    eventCount: eventIds.length,
    eventIds,
    missingEventIds: expectedEventIds.filter(eventId => !eventIds.includes(eventId)),
  }
  concurrentAppendExpected = {
    attempt,
    eventCount: expectedEventIds.length,
    eventIds: expectedEventIds,
    missingEventIds: [],
  }
  if (concurrentAppendActual.eventCount !== concurrentAppendExpected.eventCount ||
    concurrentAppendActual.missingEventIds.length > 0) {
    break
  }
}

const terminalRaceRoot = await mkdtemp(join(tmpdir(), 'workflow-terminal-race-'))
for (const firstStatus of ['completed', 'failed'] as const) {
  const terminalRaceRunId = `wf_terminal_race_${firstStatus}`
  const terminalRaceSnapshot = await startWorkflowRunSession({
    cwd: terminalRaceRoot,
    taskId: `w-terminal-race-${firstStatus}`,
    workflowRunId: terminalRaceRunId,
    plan: {
      name: 'terminal-race-workflow',
      description: 'terminal race workflow',
      defaults: {
        maxConcurrency: 1,
        maxAgents: 1,
        maxRetries: 0,
        fanout: 1,
        concurrency: 1,
        review: 'none',
        execution: 'agent',
      },
      phases: [],
      totalAgents: 1,
    },
  })
  const failedResults = [{
    phaseId: 'phase-1',
    agentId: 'agent-1',
    index: 0,
    status: 'failed' as const,
    error: 'first terminal failure',
    tokenCount: 321,
    toolUseCount: 5,
  }]
  const complete = () => completeWorkflowRunSession({
    cwd: terminalRaceRoot,
    session: terminalRaceSnapshot,
    results: terminalResults,
    tokenCount: 123,
    toolUseCount: 4,
  })
  const fail = () => failWorkflowRunSession({
    cwd: terminalRaceRoot,
    session: terminalRaceSnapshot,
    results: failedResults,
    error: 'first terminal failure',
    tokenCount: 321,
    toolUseCount: 5,
  })
  await Promise.all(firstStatus === 'completed'
    ? [complete(), fail()]
    : [fail(), complete()])
  const terminalRaceFinalSession = await loadWorkflowRunSession({
    cwd: terminalRaceRoot,
    workflowRunId: terminalRaceRunId,
  })
  assert.ok(terminalRaceFinalSession)
  const expectedTerminalState = firstStatus === 'completed' ? {
    status: 'completed',
    results: terminalResults,
    tokenCount: 123,
    toolUseCount: 4,
    error: undefined,
  } : {
    status: 'failed',
    results: failedResults,
    tokenCount: 321,
    toolUseCount: 5,
    error: 'first terminal failure',
  }
  assert.deepEqual({
    status: terminalRaceFinalSession.status,
    results: terminalRaceFinalSession.results,
    tokenCount: terminalRaceFinalSession.tokenCount,
    toolUseCount: terminalRaceFinalSession.toolUseCount,
    error: terminalRaceFinalSession.error,
  }, expectedTerminalState)
  const restartedTerminalSession = await startWorkflowRunSession({
    cwd: terminalRaceRoot,
    taskId: `w-restarted-terminal-race-${firstStatus}`,
    workflowRunId: terminalRaceRunId,
    plan: {
      name: 'restarted-terminal-race-workflow',
      description: 'late start must not reset terminal workflow',
      defaults: {
        maxConcurrency: 1,
        maxAgents: 1,
        maxRetries: 0,
        fanout: 1,
        concurrency: 1,
        review: 'none',
        execution: 'agent',
      },
      phases: [],
      totalAgents: 1,
    },
  })
  assert.deepEqual({
    status: restartedTerminalSession.status,
    results: restartedTerminalSession.results,
    tokenCount: restartedTerminalSession.tokenCount,
    toolUseCount: restartedTerminalSession.toolUseCount,
    error: restartedTerminalSession.error,
  }, expectedTerminalState)
}

const ownershipRoot = await mkdtemp(join(tmpdir(), 'workflow-ownership-'))
const ownershipRunId = 'wf_unique_ownership'
const ownershipPlan = {
  name: 'unique-ownership-workflow',
  description: 'only one caller may own a workflow run ID',
  defaults: {
    maxConcurrency: 1,
    maxAgents: 1,
    maxRetries: 0,
    fanout: 1,
    concurrency: 1,
    review: 'none' as const,
    execution: 'agent' as const,
  },
  phases: [],
  totalAgents: 1,
}
const ownershipStarts = await Promise.all(
  Array.from({ length: 8 }, (_, index) =>
    tryStartWorkflowRunSession({
      cwd: index % 2 === 0 ? ownershipRoot : `${ownershipRoot}/.`,
      taskId: `w-ownership-${index}`,
      workflowRunId: ownershipRunId,
      plan: ownershipPlan,
    }),
  ),
)
assert.equal(ownershipStarts.filter(result => result.started).length, 1)
const ownershipTaskId = ownershipStarts.find(result => result.started)?.session.taskId
assert.ok(ownershipTaskId)
assert.equal(
  ownershipStarts.every(result => result.session.taskId === ownershipTaskId),
  true,
)
await updateWorkflowRunSessionStatus({
  cwd: ownershipRoot,
  workflowRunId: ownershipRunId,
  status: 'paused',
})
const pausedOwnershipStart = await tryStartWorkflowRunSession({
  cwd: ownershipRoot,
  taskId: 'w-paused-ownership-rerun',
  workflowRunId: ownershipRunId,
  plan: ownershipPlan,
})
assert.equal(pausedOwnershipStart.started, false)
assert.equal(pausedOwnershipStart.session.status, 'paused')
assert.equal(pausedOwnershipStart.session.taskId, ownershipTaskId)

const pathAliasRoot = await mkdtemp(join(tmpdir(), 'workflow-path-alias-'))
const pathAliasCwd = `${pathAliasRoot}/.`
const pathAliasRunId = 'wf_path_alias'
const pathAliasSnapshot = await startWorkflowRunSession({
  cwd: pathAliasRoot,
  taskId: 'w-path-alias',
  workflowRunId: pathAliasRunId,
  plan: {
    name: 'path-alias-workflow',
    description: 'path alias workflow',
    defaults: {
      maxConcurrency: 1,
      maxAgents: 1,
      maxRetries: 0,
      fanout: 1,
      concurrency: 1,
      review: 'none',
      execution: 'agent',
    },
    phases: [],
    totalAgents: 1,
  },
})
const pathAliasEvents = Array.from({ length: 48 }, (_, index) => ({
  type: 'workflow_log' as const,
  workflowRunId: pathAliasRunId,
  message: `path alias append ${index}`,
  timestamp: 1783399711750 + index,
}))
await Promise.all(pathAliasEvents.map((event, index) => appendWorkflowRunEvent({
  cwd: index % 2 === 0 ? pathAliasRoot : pathAliasCwd,
  session: pathAliasSnapshot,
  event,
})))
const pathAliasFinalSession = await loadWorkflowRunSession({
  cwd: pathAliasRoot,
  workflowRunId: pathAliasRunId,
})
assert.ok(pathAliasFinalSession)
assert.deepEqual(
  pathAliasFinalSession.events
    .map(event => event.type === 'workflow_log' ? event.message : undefined)
    .filter((message): message is string => typeof message === 'string')
    .sort(),
  pathAliasEvents.map(event => event.message).sort(),
)

const crossProcessRoot = await mkdtemp(join(tmpdir(), 'workflow-cross-process-'))
const crossProcessRunId = 'wf_cross_process'
await startWorkflowRunSession({
  cwd: crossProcessRoot,
  taskId: 'w-cross-process',
  workflowRunId: crossProcessRunId,
  plan: {
    name: 'cross-process-workflow',
    description: 'cross process workflow',
    defaults: {
      maxConcurrency: 1,
      maxAgents: 1,
      maxRetries: 0,
      fanout: 1,
      concurrency: 1,
      review: 'none',
      execution: 'agent',
    },
    phases: [],
    totalAgents: 1,
  },
})
const crossProcessWorkerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'workflowRunSessions.crossProcessWorker.ts',
)
const crossProcessWorkerCount = 6
const crossProcessEventCount = 12
const crossProcessReadyDir = join(crossProcessRoot, 'ready')
const crossProcessStartPath = join(crossProcessRoot, 'start')
await mkdir(crossProcessReadyDir)
const crossProcessWorkers = Array.from({ length: crossProcessWorkerCount }, (_, workerIndex) => {
  const child = spawn(process.execPath, [
    crossProcessWorkerPath,
    crossProcessRoot,
    crossProcessRunId,
    String(workerIndex),
    String(crossProcessEventCount),
    crossProcessReadyDir,
    crossProcessStartPath,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const done = new Promise<void>((resolve, reject) => {
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`cross-process worker ${workerIndex} exited ${code}: ${stderr}`))
    })
  })
  void done.catch(() => undefined)
  return { child, done }
})
const crossProcessWorkerFailure = Promise.race(crossProcessWorkers.map(
  (worker, workerIndex) => worker.done.then(() => {
    throw new Error(`cross-process worker ${workerIndex} exited before start`)
  }),
))
const waitForCrossProcessWorkers = async () => {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      await Promise.all(Array.from(
        { length: crossProcessWorkerCount },
        (_, index) => access(join(crossProcessReadyDir, String(index))),
      ))
      return
    } catch {
      if (Date.now() >= deadline) {
        throw new Error('timed out waiting for cross-process workers')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}
try {
  await Promise.race([waitForCrossProcessWorkers(), crossProcessWorkerFailure])
  await writeFile(crossProcessStartPath, '')
  await Promise.all(crossProcessWorkers.map(worker => worker.done))
} catch (error) {
  for (const worker of crossProcessWorkers) worker.child.kill()
  await Promise.allSettled(crossProcessWorkers.map(worker => worker.done))
  throw error
}
const crossProcessFinalSession = await loadWorkflowRunSession({
  cwd: crossProcessRoot,
  workflowRunId: crossProcessRunId,
})
assert.ok(crossProcessFinalSession)
const crossProcessEventMessages = crossProcessFinalSession.events
  .map(event => event.type === 'workflow_log' ? event.message : undefined)
  .filter((message): message is string => typeof message === 'string')
  .sort()
const crossProcessExpectedMessages = Array.from(
  { length: crossProcessWorkerCount },
  (_, workerIndex) => Array.from(
    { length: crossProcessEventCount },
    (_, eventIndex) => `cross process append ${workerIndex}:${eventIndex}`,
  ),
).flat().sort()
assert.deepEqual(crossProcessEventMessages, crossProcessExpectedMessages)

const appendCompleteRoot = await mkdtemp(join(tmpdir(), 'workflow-append-complete-'))
const appendCompleteAttempts = 8
const appendCompleteEventCount = 48
let appendCompleteActual = {
  attempt: -1,
  status: 'completed',
  results: [] as WorkflowAgentResult[],
  tokenCount: 0 as number | undefined,
  toolUseCount: 0 as number | undefined,
}
let appendCompleteExpected = appendCompleteActual
for (let attempt = 0; attempt < appendCompleteAttempts; attempt++) {
  const workflowRunId = `wf_append_complete_${attempt}`
  const appendCompleteSnapshot = await startWorkflowRunSession({
    cwd: appendCompleteRoot,
    taskId: `w-append-complete-${attempt}`,
    workflowRunId,
    plan: {
      name: 'append-complete-workflow',
      description: 'append complete workflow',
      defaults: {
        maxConcurrency: 1,
        maxAgents: 1,
        maxRetries: 0,
        fanout: 1,
        concurrency: 1,
        review: 'none',
        execution: 'agent',
      },
      phases: [],
      totalAgents: 1,
    },
  })
  const completedResults = [{
    phaseId: 'phase-1',
    agentId: 'agent-1',
    index: 0,
    status: 'completed' as const,
    output: `terminal result ${attempt}`,
    tokenCount: 700 + attempt,
    toolUseCount: 70 + attempt,
  }]
  const appendCompleteEvents = Array.from({ length: appendCompleteEventCount }, (_, index) => ({
    type: 'workflow_log' as const,
    workflowRunId,
    message: `append complete ${attempt}:${index}`,
    timestamp: 1783399711800 + index,
  }))
  const appendPromises = appendCompleteEvents.map(event => appendWorkflowRunEvent({
    cwd: appendCompleteRoot,
    session: appendCompleteSnapshot,
    event,
  }))
  await Promise.all([
    ...appendPromises,
    completeWorkflowRunSession({
      cwd: appendCompleteRoot,
      session: appendCompleteSnapshot,
      results: completedResults,
      tokenCount: 700 + attempt,
      toolUseCount: 70 + attempt,
    }),
  ])
  const appendCompleteFinalSession = await loadWorkflowRunSession({
    cwd: appendCompleteRoot,
    workflowRunId,
  })
  assert.ok(appendCompleteFinalSession)
  appendCompleteActual = {
    attempt,
    status: appendCompleteFinalSession.status,
    results: appendCompleteFinalSession.results,
    tokenCount: appendCompleteFinalSession.tokenCount,
    toolUseCount: appendCompleteFinalSession.toolUseCount,
  }
  appendCompleteExpected = {
    attempt,
    status: 'completed',
    results: completedResults,
    tokenCount: 700 + attempt,
    toolUseCount: 70 + attempt,
  }
  if (appendCompleteActual.status !== appendCompleteExpected.status ||
    JSON.stringify(appendCompleteActual.results) !== JSON.stringify(appendCompleteExpected.results) ||
    appendCompleteActual.tokenCount !== appendCompleteExpected.tokenCount ||
    appendCompleteActual.toolUseCount !== appendCompleteExpected.toolUseCount) {
    break
  }
}
assert.deepEqual({
  concurrentAppendActual,
  appendCompleteActual,
}, {
  concurrentAppendActual: concurrentAppendExpected,
  appendCompleteActual: appendCompleteExpected,
})

const terminalGuardRoot = await mkdtemp(join(tmpdir(), 'workflow-terminal-guard-'))
const terminalGuardRunId = 'wf_terminal_guard'
const terminalGuardSnapshot = await startWorkflowRunSession({
  cwd: terminalGuardRoot,
  taskId: 'w-terminal-guard',
  workflowRunId: terminalGuardRunId,
  plan: {
    name: 'terminal-guard-workflow',
    description: 'terminal guard workflow',
    defaults: {
      maxConcurrency: 1,
      maxAgents: 1,
      maxRetries: 0,
      fanout: 1,
      concurrency: 1,
      review: 'none',
      execution: 'agent',
    },
    phases: [],
    totalAgents: 0,
  },
})
await completeWorkflowRunSession({
  cwd: terminalGuardRoot,
  session: { ...terminalGuardSnapshot, agentCount: 3 },
  results: terminalResults,
  tokenCount: 123,
  toolUseCount: 4,
})
await updateWorkflowRunSessionStatus({
  cwd: terminalGuardRoot,
  workflowRunId: terminalGuardRunId,
  status: 'paused',
})
await updateWorkflowRunSessionProgress({
  cwd: terminalGuardRoot,
  session: { ...terminalGuardSnapshot, agentCount: 2 },
  results: [],
  tokenCount: 100,
  toolUseCount: 3,
})
const terminalGuardFinalSession = await loadWorkflowRunSession({
  cwd: terminalGuardRoot,
  workflowRunId: terminalGuardRunId,
})
assert.ok(terminalGuardFinalSession)
assert.deepEqual({
  status: terminalGuardFinalSession.status,
  results: terminalGuardFinalSession.results,
  agentCount: terminalGuardFinalSession.agentCount,
  tokenCount: terminalGuardFinalSession.tokenCount,
  toolUseCount: terminalGuardFinalSession.toolUseCount,
}, {
  status: 'completed',
  results: terminalResults,
  agentCount: 3,
  tokenCount: 123,
  toolUseCount: 4,
})

console.log('workflowRunSessions.test.ts passed')
