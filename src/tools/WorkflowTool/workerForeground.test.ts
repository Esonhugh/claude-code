import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { createStore } from '../../state/store.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { GENERAL_PURPOSE_AGENT } from '../AgentTool/built-in/generalPurposeAgent.js'
import type { WorkflowDryRunPlan } from './workflowSpec.js'

const childFlag = 'CLAUDE_CODE_WORKFLOW_FOREGROUND_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  for (const fork of ['0', '1']) test('Workflow workers await the real Agent lifecycle without caller credentials, fork=' + fork, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'workflow-foreground-')))
    const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config'), XDG_CONFIG_HOME: join(directory, 'xdg'), XDG_CACHE_HOME: join(directory, 'cache'), TMPDIR: directory, ANTHROPIC_API_KEY: 'owned-workflow-foreground-dummy', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', [childFlag]: '1', CLAUDE_CODE_FORK_SUBAGENT: fork },
      stdout: 'pipe', stderr: 'pipe',
    })
    const stdoutText = new Response(child.stdout).text(), stderrText = new Response(child.stderr).text()
    try {
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, stdoutText, stderrText])
      expect(exitCode, stdout + stderr).toBe(0)
      expect(stderr).toContain('2 pass')
      expect(stderr).toContain('0 fail')
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited }
      console.info(await stdoutText, await stderrText)
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
} else {
  const streams: Array<{ started: ReturnType<typeof Promise.withResolvers<void>>; finish: ReturnType<typeof Promise.withResolvers<void>> }> = []
  const inFlight: Promise<unknown>[] = []
  const observedExecutionModes: boolean[] = []
  mock.module('../AgentTool/runAgent.js', () => ({
    async *runAgent(params: { isAsync: boolean }) {
      const stream = streams[0]
      if (!stream) throw new Error('Unexpected worker execution')
      observedExecutionModes.push(params.isAsync)
      stream.started.resolve()
      await stream.finish.promise
      yield { type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: {
        id: 'msg_workflow_worker', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'worker-finished' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: 'standard', cache_creation: null },
      } }
    },
  }))
  const { AgentTool } = await import('../AgentTool/AgentTool.js')
  const { runWorkflowPlan } = await import('./runWorkflow.js')
  const { runWorkflowScript } = await import('./workflowScriptRuntime.js')
  afterEach(async () => {
    for (const stream of streams) stream.finish.resolve()
    await Promise.allSettled(inFlight.splice(0))
    streams.length = 0
    observedExecutionModes.length = 0
  })

  for (const entry of ['plan', 'script'] as const) {
    test(entry + ' keeps its worker running until the actual agent finishes', async () => {
      const state = getDefaultAppState()
      const store = createStore({ ...state, toolPermissionContext: getEmptyToolPermissionContext(), mcp: { ...state.mcp, clients: [], tools: [] } })
      const context = {
        options: { commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6', tools: [AgentTool], verbose: false, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false, workflowRunInForeground: true, agentDefinitions: { activeAgents: [GENERAL_PURPOSE_AGENT], inactiveAgents: [], allowedAgentTypes: undefined } },
        messages: [], abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10), getCwd: () => process.cwd(),
        getAppState: store.getState, setAppState: store.setState, toolUseId: 'toolu_workflow_foreground_' + entry,
        setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
      } as unknown as ToolUseContext
      const script = `export const meta = { name: "worker-foreground-script", description: "Await an actual Agent worker", phases: [{ title: "root", detail: "Worker lifecycle" }] }
phase("root")
const result = await agent("Return worker-finished", { label: "worker", agentType: "general-purpose" })
return { result }`
      const plan: WorkflowDryRunPlan = {
        name: 'worker-foreground-' + entry, description: 'Await an actual Agent worker',
        defaults: { maxConcurrency: 1, maxAgents: 1, maxRetries: 0, fanout: 1, concurrency: 1, review: 'none', permissionMode: 'bypassPermissions', execution: 'agent' },
        phases: [{ id: 'root', description: 'Worker lifecycle', prompt: 'Return worker-finished', agentType: 'general-purpose', dependsOn: [], fanout: 1, concurrency: 1, review: 'none', permissionMode: 'bypassPermissions' }], totalAgents: 1,
        ...(entry === 'script' && { runScriptSnapshot: script }),
      }
      const stream = { started: Promise.withResolvers<void>(), finish: Promise.withResolvers<void>() }
      streams.push(stream)
      const args = { plan, context, canUseTool: async () => ({ behavior: 'allow' as const }), assistantMessage: { message: { id: 'msg_parent' } } as never, workflowRunId: 'wf_foreground_' + entry }
      const completion = entry === 'plan' ? runWorkflowPlan(args) : runWorkflowScript({ ...args, script })
      inFlight.push(completion)
      await stream.started.promise
      try {
        await Promise.resolve()
        const task = Object.values(store.getState().tasks).find(task => task.type === 'local_workflow')
        expect(task?.status).toBe('running')
        expect(task?.results).toEqual([])
      } finally { stream.finish.resolve() }
      await completion
      const task = Object.values(store.getState().tasks).find(task => task.type === 'local_workflow')
      expect(task?.status).toBe('completed')
      if (task?.type !== 'local_workflow') throw new Error('Missing workflow task')
      expect(task.results).toHaveLength(1)
      expect(task.results[0]?.status).toBe('completed')
      expect(task.results[0]?.output).toBe('worker-finished')
      expect(observedExecutionModes).toEqual([process.env.CLAUDE_CODE_FORK_SUBAGENT === '1'])
      expect(store.getState().runningSubagents).toBe(0)
    }, 15_000)
  }
}
