#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkflowScriptAgentChainIdentity } from './workflowResumeCache.js'
import { createWorkflowRunId } from './workflowScriptPersistence.js'
import { loadWorkflowRunSession, officialProjectDirName } from './workflowRunSessions.js'

const generatedRunId = createWorkflowRunId()
assert.match(generatedRunId, /^wf_[a-z0-9-]{6,}$/)
assert.equal(generatedRunId.slice(3).includes('_'), false)

const projectsRoot = await mkdtemp(join(tmpdir(), 'official-workflow-projects-'))
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

console.log('workflowRunSessions.test.ts passed')
