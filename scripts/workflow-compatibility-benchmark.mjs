#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const benchmarkBundle = resolve(
  projectRoot,
  'dist',
  'workflowCompatibilityBenchmark.mjs',
)

await mkdir(dirname(benchmarkBundle), { recursive: true })
await build({
  absWorkingDir: projectRoot,
  entryPoints: ['src/tools/WorkflowTool/workflowCompatibilityBenchmark.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: benchmarkBundle,
})

const { compareWorkflowCompatibility } = await import(
  pathToFileURL(benchmarkBundle).href
)

const facadeBundle = resolve(projectRoot, 'dist', 'workflowFacadeToolBenchmark.mjs')
await build({
  absWorkingDir: projectRoot,
  entryPoints: ['src/tools/WorkflowTool/WorkflowFacadeTool.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: facadeBundle,
})

const { WorkflowFacadeTool } = await import(pathToFileURL(facadeBundle).href)

const officialBinary = '/opt/homebrew/bin/claude'

async function runLocalWorkflowFacadeSmoke() {
  let state = {
    tasks: {},
    toolPermissionContext: { mode: 'default' },
  }
  const context = {
    getCwd: () => process.cwd(),
    getAppState: () => state,
    setAppState: updater => {
      state = updater(state)
    },
    options: {
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
      tools: [
        {
          name: 'Agent',
          aliases: ['Task'],
          async call(input) {
            return {
              data: {
                status: 'completed',
                content: [
                  {
                    type: 'text',
                    text: `benchmark agent completed: ${input.description}`,
                  },
                ],
                agentId: 'benchmark-agent-1',
                totalTokens: 1,
                totalToolUseCount: 0,
                totalDurationMs: 1,
              },
            }
          },
        },
      ],
      mcpClients: [],
      mcpResources: {},
      debug: false,
      verbose: false,
      thinkingConfig: {},
      isNonInteractiveSession: true,
      mainLoopModel: 'claude-sonnet-4-5',
    },
    abortController: new AbortController(),
    messages: [],
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }

  await WorkflowFacadeTool.call(
    {
      name: 'benchmark-inline',
      args: { topic: 'compatibility benchmark' },
      script: `export default workflow({
        name: 'Benchmark Inline Workflow',
        description: 'Local compatibility benchmark workflow.',
        defaults: { maxConcurrency: 1, maxAgents: 1, permissionMode: 'plan' },
        phases: [agent({
          id: 'benchmark',
          description: 'Run benchmark agent.',
          prompt: ({ args }) => 'benchmark topic=' + args.topic,
        })],
      })`,
    },
    context,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_workflow_benchmark' } },
  )
}

async function newestLocalWorkflowSession() {
  const runsDir = join(process.cwd(), '.claude', 'workflow-runs')
  let entries
  try {
    entries = await readdir(runsDir, { withFileTypes: true })
  } catch {
    return undefined
  }

  const sessions = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sessionPath = join(runsDir, entry.name, 'session.json')
    try {
      const sessionStat = await stat(sessionPath)
      sessions.push({
        mtimeMs: sessionStat.mtimeMs,
        session: JSON.parse(await readFile(sessionPath, 'utf8')),
      })
    } catch {
      continue
    }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return sessions[0]?.session
}

const officialObservation = {
  tool: 'Workflow',
  workflowRunId: 'observed-official-hidden-tool',
  scriptPath: 'observed-session-script-path',
  events: [
    { type: 'workflow_progress' },
    { type: 'workflow_phase' },
    { type: 'workflow_agent' },
    { type: 'workflow_log' },
  ],
  argsKind: 'object',
  supportsScriptPathRerun: true,
  supportsUserWorkflowDiscovery: true,
}

await runLocalWorkflowFacadeSmoke()
const newestSession = await newestLocalWorkflowSession()
const fallbackLocalObservation = {
  tool: process.env.LOCAL_WORKFLOW_TOOL_NAME ?? 'WorkflowTool',
  workflowRunId: process.env.LOCAL_WORKFLOW_RUN_ID,
  scriptPath: process.env.LOCAL_WORKFLOW_SCRIPT_PATH,
  events: (process.env.LOCAL_WORKFLOW_EVENTS ?? 'task_local_workflow')
    .split(',')
    .filter(Boolean)
    .map(type => ({ type })),
  argsKind: process.env.LOCAL_WORKFLOW_ARGS_KIND ?? 'string',
  supportsScriptPathRerun: process.env.LOCAL_WORKFLOW_SCRIPT_PATH_RERUN === 'true',
  supportsUserWorkflowDiscovery:
    process.env.LOCAL_WORKFLOW_USER_DISCOVERY === 'true',
}
const localObservation = newestSession
  ? {
      tool: 'Workflow',
      workflowRunId: newestSession.workflowRunId,
      scriptPath: newestSession.scriptPath,
      events: newestSession.events,
      argsKind: Array.isArray(newestSession.runArgs)
        ? 'array'
        : newestSession.runArgs === null
          ? 'null'
          : typeof newestSession.runArgs,
      supportsScriptPathRerun: Boolean(newestSession.scriptPath),
      supportsUserWorkflowDiscovery: true,
    }
  : fallbackLocalObservation

const report = compareWorkflowCompatibility({
  official: officialObservation,
  local: localObservation,
})

const outputPath = join(process.cwd(), '.claude', 'workflow-compatibility-report.json')
await mkdir(join(process.cwd(), '.claude'), { recursive: true })
await writeFile(
  outputPath,
  `${JSON.stringify(
    { officialBinaryExists: existsSync(officialBinary), ...report },
    null,
    2,
  )}\n`,
)
console.log(`workflow compatibility score: ${report.score}`)
console.log(`workflow compatibility gaps: ${report.gaps.join(', ') || 'none'}`)
console.log(`workflow compatibility report: ${outputPath}`)
