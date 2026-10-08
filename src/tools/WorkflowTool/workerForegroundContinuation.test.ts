import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { createStore } from '../../state/store.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { GENERAL_PURPOSE_AGENT } from '../AgentTool/built-in/generalPurposeAgent.js'
import { backgroundAgentTask, isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { getCommandQueue } from '../../utils/messageQueueManager.js'

const childFlag = 'CLAUDE_CODE_WORKFLOW_CONTINUATION_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('Workflow preserves actual foreground-to-background ownership and cancellation', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'workflow-continuation-')))
    const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config'), XDG_CONFIG_HOME: join(directory, 'xdg'), XDG_CACHE_HOME: join(directory, 'cache'), TMPDIR: directory, ANTHROPIC_API_KEY: 'owned-workflow-continuation-dummy', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_FORK_SUBAGENT: '0', [childFlag]: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text()
    try {
      const [exitCode, out, err] = await Promise.all([child.exited, stdout, stderr])
      expect(exitCode, out + err).toBe(0)
      expect(err).toContain('3 pass')
      expect(err).toContain('0 fail')
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited }
      console.info(await stdout, await stderr)
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
} else {
  const controls: Array<{ foreground: ReturnType<typeof Promise.withResolvers<void>>; continue: ReturnType<typeof Promise.withResolvers<void>>; progressed: ReturnType<typeof Promise.withResolvers<void>>; finish: ReturnType<typeof Promise.withResolvers<void>>; signal?: AbortSignal; starts: number }> = []
  const inFlight: Promise<unknown>[] = []
  function control() {
    const item = { foreground: Promise.withResolvers<void>(), continue: Promise.withResolvers<void>(), progressed: Promise.withResolvers<void>(), finish: Promise.withResolvers<void>(), signal: undefined as AbortSignal | undefined, starts: 0 }
    controls.push(item)
    return item
  }
  function message(id: string) {
    return { type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: {
      id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: id === 'worker-finished' ? [{ type: 'text', text: id }] : [{ type: 'tool_use', id: 'toolu_' + id, name: 'Read', input: { file_path: id } }], stop_reason: id === 'worker-finished' ? 'end_turn' : 'tool_use', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: 'standard', cache_creation: null },
    } }
  }
  async function waitOrCancel(pending: Promise<void>, signal: AbortSignal) {
    const aborted = Promise.withResolvers<void>(), onAbort = () => aborted.resolve()
    signal.addEventListener('abort', onAbort, { once: true })
    try { if (signal.aborted) onAbort(); await Promise.race([pending, aborted.promise]); signal.throwIfAborted() }
    finally { signal.removeEventListener('abort', onAbort) }
  }
  mock.module('../AgentTool/runAgent.js', () => ({
    async *runAgent(params: { override?: { abortController?: AbortController }; toolUseContext: ToolUseContext }) {
      const item = controls[0]
      if (!item) throw new Error('Unexpected worker execution')
      item.starts += 1
      const signal = params.override?.abortController?.signal ?? params.toolUseContext.abortController.signal
      item.signal = signal
      yield message('msg_before_background')
      yield { type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_msg_before_background', content: 'ok' }] } }
      item.foreground.resolve()
      await waitOrCancel(item.continue.promise, signal)
      yield message('msg_after_background')
      yield { type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_msg_after_background', content: 'ok' }] } }
      item.progressed.resolve()
      await waitOrCancel(item.finish.promise, signal)
      yield message('worker-finished')
    },
  }))
  const { AgentTool } = await import('../AgentTool/AgentTool.js')
  const { callWorkflowAgent } = await import('./runWorkflow.js')
  afterEach(async () => {
    for (const item of controls) { item.continue.resolve(); item.finish.resolve() }
    await Promise.allSettled(inFlight.splice(0))
    controls.length = 0
  })
  function setup() {
    const state = getDefaultAppState(), store = createStore({ ...state, toolPermissionContext: getEmptyToolPermissionContext(), mcp: { ...state.mcp, clients: [], tools: [] } })
    const context = {
      options: { commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6', tools: [AgentTool], verbose: false, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false, agentDefinitions: { activeAgents: [GENERAL_PURPOSE_AGENT], inactiveAgents: [], allowedAgentTypes: undefined } },
      messages: [], abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10), getAppState: store.getState, setAppState: store.setState, toolUseId: 'toolu_workflow_continuation',
      setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
    } as unknown as ToolUseContext
    return { context, store }
  }
  function start(context: ToolUseContext, seen: unknown[] = []) {
    const result = callWorkflowAgent(AgentTool, { prompt: 'Await worker', description: 'workflow continuation', subagent_type: 'general-purpose', run_in_background: false } as never, context, async () => ({ behavior: 'allow' as const }), { message: { id: 'msg_parent' } } as never, progress => seen.push(progress.data))
    inFlight.push(result)
    return result.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  }
  function background(context: ToolUseContext) {
    const task = Object.values(context.getAppState().tasks).find(isLocalAgentTask)
    if (!task) throw new Error('Missing real foreground task')
    expect(backgroundAgentTask(task.id, context.getAppState, context.setAppState)).toBe(true)
    return task.id
  }

  test('background continuation keeps one stream and forwards actual progress', async () => {
    const { context } = setup(), item = control(), seen: unknown[] = []
    let settled = false
    const outcome = start(context, seen).then(value => { settled = true; return value })
    await item.foreground.promise
    const id = background(context)
    item.continue.resolve()
    await item.progressed.promise
    try {
      expect(settled).toBe(false)
      expect(seen).toContainEqual(expect.objectContaining({ type: 'agent_progress', message: expect.objectContaining({ message: expect.objectContaining({ id: 'msg_after_background' }) }) }))
    } finally { item.finish.resolve() }
    const completed = await outcome
    expect(completed.error).toBeUndefined()
    expect(completed.value?.data).toMatchObject({ status: 'completed', totalTokens: 12, content: [{ type: 'text', text: 'worker-finished' }] })
    expect(item.starts).toBe(1)
    expect(getCommandQueue().filter(command => String(command.value).includes(id))).toHaveLength(0)
  })

  for (const move of [false, true]) test('cancel preserves the original reason, background=' + move, async () => {
    const { context } = setup(), item = control(), outcome = start(context)
    await item.foreground.promise
    if (move) background(context)
    item.continue.resolve()
    await item.progressed.promise
    const reason = new Error('owned continuation cancellation ' + move)
    context.abortController.abort(reason)
    const cancelled = await outcome
    expect(cancelled.value).toBeUndefined()
    expect(cancelled.error).toBe(reason)
    expect(item.signal?.reason).toBe(reason)
    expect(item.starts).toBe(1)
  })
}
