#!/usr/bin/env node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')
const outputRoot = resolve(projectRoot, '.claude', 'workflow-running-detail-capture')
const bundlePath = resolve(outputRoot, 'render-running-detail.mjs')
const transcriptPath = resolve(outputRoot, 'local-running-detail.txt')
const session = `workflow-running-detail-${process.pid}`

function runTmux(args) {
  const result = spawnSync('tmux', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`tmux ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trimEnd()
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

await build({
  absWorkingDir: projectRoot,
  entryPoints: ['src/components/tasks/workflowDetailSnapshot.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundlePath,
})

const { formatWorkflowDetailSnapshot } = await import(pathToFileURL(bundlePath).href)
const workflow = {
  id: 'w-running-detail',
  type: 'local_workflow',
  status: 'running',
  description: 'Workflow: Running Detail Capture',
  workflowName: 'Running Detail Capture',
  workflowRunId: 'wf_running_detail',
  scriptPath: '/tmp/running-detail-workflow.js',
  runArgs: { topic: 'running detail parity' },
  summary: 'Dynamic workflow running',
  agentCount: 4,
  progressVersion: 7,
  defaultModel: 'claude-sonnet-4-5',
  tokenCount: 1234,
  toolUseCount: 5,
  execution: 'agent',
  runtime: { kind: 'javascript-worker', sourcePath: '/tmp/running-detail-workflow.js', isolated: true },
  sourcePath: '/tmp/running-detail-workflow.js',
  runScriptSnapshot: 'export const meta = {}',
  startTime: 1_000,
  endTime: 3_500,
  outputFile: '.claude/tasks/w-running-detail.output',
  outputOffset: 0,
  notified: false,
  phases: [
    {
      id: 'scope',
      status: 'completed',
      agentIds: ['scope-1'],
      completedAgentIds: ['scope-1'],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [
        { phaseId: 'scope', agentId: 'scope-1', index: 0, status: 'completed', output: 'scope done' },
      ],
    },
    {
      id: 'verify',
      status: 'running',
      agentIds: ['verify-1', 'verify-2', 'verify-3'],
      completedAgentIds: ['verify-1'],
      skippedAgentIds: ['verify-2'],
      failedAgentIds: ['verify-3'],
      results: [
        { phaseId: 'verify', agentId: 'verify-1', index: 0, status: 'completed', output: 'verified claim' },
        { phaseId: 'verify', agentId: 'verify-2', index: 1, status: 'skipped' },
      ],
      error: 'verify-3 stalled',
    },
  ],
  results: [
    { phaseId: 'scope', agentId: 'scope-1', index: 0, status: 'completed', output: 'scope done' },
    { phaseId: 'verify', agentId: 'verify-1', index: 0, status: 'completed', output: 'verified claim' },
    { phaseId: 'verify', agentId: 'verify-2', index: 1, status: 'skipped' },
  ],
  events: [
    {
      type: 'workflow_progress',
      workflowRunId: 'wf_running_detail',
      status: 'running',
      completedAgents: 2,
      totalAgents: 4,
      timestamp: 10,
    },
    {
      type: 'workflow_agent',
      workflowRunId: 'wf_running_detail',
      phaseId: 'scope',
      agentId: 'scope-1',
      status: 'completed',
      cacheHit: true,
      timestamp: 11,
    },
    {
      type: 'workflow_agent',
      workflowRunId: 'wf_running_detail',
      phaseId: 'verify',
      agentId: 'verify-2',
      status: 'skipped',
      timestamp: 12,
    },
  ],
}
const snapshot = formatWorkflowDetailSnapshot(workflow)
const tempRoot = await mkdtemp(join(tmpdir(), 'workflow-running-detail-'))
const paneFile = join(tempRoot, 'snapshot.txt')
await writeFile(paneFile, `${snapshot}\n`)
let passed = false
try {
  runTmux([
    'new-session',
    '-d',
    '-s',
    session,
    '-x',
    '120',
    '-y',
    '32',
    'sh',
    '-lc',
    `cat ${shellQuote(paneFile)}; exec sh`,
  ])
  spawnSync('sleep', ['0.5'], { encoding: 'utf8' })
  const transcript = runTmux(['capture-pane', '-p', '-S', '-', '-t', session])
  await writeFile(transcriptPath, `${transcript}\n`)
  const captured = await readFile(transcriptPath, 'utf8')
  const required = [
    'Running Detail Capture',
    'Dynamic workflow running',
    '2/4 agents',
    '╭ Phases',
    'scope · 1 agent',
    '❯ 1 scope   1/1',
    '⏺ scope-1',
    'workflow_agent verify-2 skipped',
    'x stop workflow',
    'p pause',
    'esc back',
    's save',
  ]
  const compactCaptured = captured.replace(/\s+/g, '')
  for (const item of required) {
    if (!compactCaptured.includes(item.replace(/\s+/g, ''))) {
      throw new Error(`running detail transcript missing: ${item}`)
    }
  }
  passed = true
  console.log(`workflow running detail capture ok: ${transcriptPath}`)
} finally {
  if (passed) {
    spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' })
  } else {
    console.error(`workflow running detail capture failed; session: ${session}; output: ${transcriptPath}`)
  }
}
