import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { createStore } from '../../state/store.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { GENERAL_PURPOSE_AGENT } from '../AgentTool/built-in/generalPurposeAgent.js'

const childFlag = 'CLAUDE_CODE_WORKFLOW_BACKGROUND_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('Workflow background ownership, progress and failure through real AgentTool', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'workflow-background-')))
    const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config'), XDG_CONFIG_HOME: join(directory, 'xdg'), XDG_CACHE_HOME: join(directory, 'cache'), TMPDIR: directory, ANTHROPIC_API_KEY: 'owned-workflow-background-dummy', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_FORK_SUBAGENT: '1', [childFlag]: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const stdoutText = new Response(child.stdout).text()
    const stderrText = new Response(child.stderr).text()
    try {
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, stdoutText, stderrText])
      expect(exitCode, stdout + stderr).toBe(0)
      expect(stderr).toContain('4 pass')
      expect(stderr).toContain('0 fail')
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited }
      console.info(await stdoutText, await stderrText)
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
} else {
  const controls: Array<{ started: ReturnType<typeof Promise.withResolvers<void>>; progress: ReturnType<typeof Promise.withResolvers<void>>; finish: ReturnType<typeof Promise.withResolvers<void>>; error?: Error; final?: Record<string, unknown>; signal?: AbortSignal }> = []
  const queue: typeof controls = []
  const inFlight: Promise<unknown>[] = []
  function control(error?: Error, final?: Record<string, unknown>) {
    const item = { started: Promise.withResolvers<void>(), progress: Promise.withResolvers<void>(), finish: Promise.withResolvers<void>(), error, final, signal: undefined as AbortSignal | undefined }
    controls.push(item); queue.push(item)
    return item
  }
  mock.module('../AgentTool/runAgent.js', () => ({
    async *runAgent(params: { override?: { abortController?: AbortController }; toolUseContext: ToolUseContext }) {
      const item = queue.shift()
      if (!item) throw new Error('Unexpected worker execution')
      const signal = params.override?.abortController?.signal ?? params.toolUseContext.abortController.signal
      item.signal = signal
      item.started.resolve()
      yield { type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: {
        id: 'msg_workflow_progress', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'real worker progress' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: 'standard', cache_creation: null },
      } }
      item.progress.resolve()
      const aborted = Promise.withResolvers<void>()
      const onAbort = () => aborted.resolve()
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        if (signal.aborted) onAbort()
        await Promise.race([item.finish.promise, aborted.promise])
        signal.throwIfAborted()
        if (item.error) throw item.error
      } finally { signal.removeEventListener('abort', onAbort) }
      if (item.final) {
        yield item.final
        return
      }
      yield { type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: {
        id: 'msg_workflow_complete', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'worker-finished' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: 'standard', cache_creation: null },
      } }
    },
  }))
  const { AgentTool } = await import('../AgentTool/AgentTool.js')
  const { callWorkflowAgent } = await import('./runWorkflow.js')
  afterEach(async () => {
    for (const item of controls) item.finish.resolve()
    await Promise.allSettled(inFlight.splice(0))
    controls.length = 0; queue.length = 0
  })
  function setup() {
    const state = getDefaultAppState()
    const store = createStore({ ...state, toolPermissionContext: getEmptyToolPermissionContext(), mcp: { ...state.mcp, clients: [], tools: [] } })
    const context = {
      options: { commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6', tools: [AgentTool], verbose: false, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false, agentDefinitions: { activeAgents: [GENERAL_PURPOSE_AGENT], inactiveAgents: [], allowedAgentTypes: undefined } },
      messages: [], abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
      getAppState: store.getState, setAppState: store.setState, toolUseId: 'toolu_workflow_background',
      setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
    } as unknown as ToolUseContext
    return { context, store }
  }
  const input = { prompt: 'Await worker', description: 'workflow worker', subagent_type: 'general-purpose', run_in_background: false }
  const allowed = async () => ({ behavior: 'allow' as const })
  const assistant = { message: { id: 'msg_workflow_parent' } } as never

  test('real background progress reaches Workflow before the result', async () => {
    const { context } = setup(); const item = control(); const seen: unknown[] = []
    const result = callWorkflowAgent(AgentTool, input as never, context, allowed, assistant, progress => seen.push(progress.data))
    inFlight.push(result)
    await item.progress.promise
    try {
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ type: 'agent_progress', message: { message: { id: 'msg_workflow_progress' } } })
    } finally { item.finish.resolve() }
    expect((await result).data).toMatchObject({ status: 'completed', totalTokens: 12, content: [{ type: 'text', text: 'worker-finished' }] })
  })

  test('actual failed worker rejects instead of completing Workflow', async () => {
    const { context } = setup(); const item = control(new Error('controlled worker failure'))
    const result = callWorkflowAgent(AgentTool, input as never, context, allowed, assistant)
    inFlight.push(result); const outcome = result.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    await item.started.promise; item.finish.resolve(); const failure = await outcome
    expect(failure.value).toBeUndefined()
    expect(failure.error).toBeInstanceOf(Error)
    expect(failure.error.message).toContain('controlled worker failure')
  })

  test('a background worker stopped by a usage limit rejects with its quota limits', async () => {
    const { AgentApiError } = await import('../AgentTool/agentToolUtils.js')
    const quotaLimits = { status: 'rejected', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false, resetsAt: 1900000000 }
    const { context } = setup()
    const item = control(undefined, {
      type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), isApiErrorMessage: true, error: 'rate_limit', quotaLimits,
      message: {
        id: 'msg_workflow_usage_limit', type: 'message', role: 'assistant', model: '<synthetic>',
        content: [{ type: 'text', text: "You've hit your limit · resets 3pm" }], stop_reason: 'stop_sequence', stop_sequence: '',
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null, cache_creation: null },
      },
    })
    const result = callWorkflowAgent(AgentTool, input as never, context, allowed, assistant)
    inFlight.push(result); const outcome = result.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    await item.started.promise; item.finish.resolve(); const failure = await outcome
    expect(failure.error).toBeInstanceOf(AgentApiError)
    expect(failure.error.message).toContain("You've hit your limit")
    expect(failure.error.quotaLimits).toEqual(quotaLimits)
  })

  test('cancel preserves the reason and leaves an unrelated real background agent running', async () => {
    const { context, store } = setup(); const unrelated = control()
    const launch = await AgentTool.call({ ...input, run_in_background: true }, { ...context, abortController: new AbortController(), toolUseId: 'toolu_unrelated' }, allowed, assistant)
    expect(launch.data.status).toBe('async_launched')
    const item = control(); const result = callWorkflowAgent(AgentTool, input as never, context, allowed, assistant)
    inFlight.push(result); const reason = new Error('owned Workflow cancellation')
    const outcome = result.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    await item.started.promise
    context.abortController.abort(reason)
    const cancellation = await outcome
    expect(cancellation.value).toBeUndefined()
    expect(cancellation.error).toBe(reason)
    expect(item.signal?.aborted).toBe(true)
    expect(item.signal?.reason).toBe(reason)
    expect(unrelated.signal?.aborted).toBe(false)
    const task = store.getState().tasks[launch.data.agentId]
    expect(task?.status).toBe('running')
    unrelated.finish.resolve()
  })
}
