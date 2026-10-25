import { expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import type { ModInput } from '../../services/mods/types.js'
import type { ModSessionMessage } from '../../services/mods/sessionMessages.js'
import type { queryModelWithStreaming } from '../../services/api/claude.js'

const childEnv = 'CLAUDE_CODE_PM1_TEAMMATE_TURN_TEST_CHILD'

if (process.env[childEnv] === '1') {
  await isolatedTests()
} else {
  test('[PM1 teammate] actual spawn and two QueryLoop turns keep stable agent identity and distinct turn identities', async () => {
    const child = Bun.spawn([process.execPath, 'test', '--timeout', '20000', import.meta.path], {
      cwd: import.meta.dir, env: { ...process.env, ANTHROPIC_API_KEY: 'dummy-pm1-teammate', [childEnv]: '1' },
      stdout: 'pipe', stderr: 'pipe', timeout: 35_000,
    })
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`PM1 isolated teammate suite failed (${code})\n${stdout}\n${stderr}`)
      expect(`${stdout}\n${stderr}`).toContain('PM1 actual teammate suite finished')
      expect(code).toBe(0)
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited }
    }
  }, 40_000)
}

async function isolatedTests(): Promise<void> {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
    VERSION: 'pm1-source-test', ISSUES_EXPLAINER: 'report an issue',
  }
  type ModelInput = Parameters<typeof queryModelWithStreaming>[0]
  const modelCalls: ModelInput[] = []
  let closed = 0
  const actualProvider = await import('../../services/api/claude.js')
  mock.module('../../services/api/claude.js', () => ({
    ...actualProvider,
    async *queryModelWithStreaming(input: ModelInput) {
      modelCalls.push(input)
      if (modelCalls.length > 2) throw new Error('PM1 teammate may enter only two finite core calls')
      try {
        const response = createAssistantMessage({ content: `FINITE_TEAMMATE_ANSWER_${modelCalls.length}` })
        Object.assign(response.message, {
          id: `pm1-teammate-response-${modelCalls.length}`, model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
        })
        yield response
      } finally { closed++ }
    },
  }))
  const { createAssistantMessage } = await import('../messages.js')
  const { createModsRuntime } = await import('../../services/mods/runtime.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../fileStateCache.js')
  const { getSessionId, getSessionProjectDir, switchSession } = await import('../../bootstrap/state.js')
  const { asSessionId } = await import('../../types/ids.js')
  const { spawnInProcessTeammate } = await import('./spawnInProcess.js')
  const { runInProcessTeammate } = await import('./inProcessRunner.js')
  const { flushSessionStorage, getAgentTranscript } = await import('../sessionStorage.js')
  const { asAgentId } = await import('../../types/ids.js')
  const { resetGitFileWatcher } = await import('../git/gitFilesystem.js')
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'mods-pm1-teammate-turn-')))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(fixture, 'config')
  const project = join(fixture, 'project')
  await mkdir(project)
  const previousSession = getSessionId(), previousProject = getSessionProjectDir()
  const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  switchSession(asSessionId(randomUUID()), project)

  test('[PM1 teammate] actual mint → runner → runAgent → QueryLoop owns each turn and retains live conversation', async () => {
    const trace: Array<{ phase: string; message?: string }> = []
    const runtime = createModsRuntime({onDiagnostic: diagnostic => { trace.push({phase:`diagnostic:${diagnostic.plugin}:${diagnostic.stage}`,message:diagnostic.message}) }})
    let state = getDefaultAppState()
    const context = {
      options: {
        commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6', tools: [], verbose: false,
        thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false,
        agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined },
      },
      abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
      getAppState: () => state, setAppState: updater => { state = updater(state) },
      setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
      messages: [], mods: runtime,
    } as ToolUseContext
    const events: Array<{ event: string; input: ModInput }> = []
    let liveMessages: Array<readonly ModSessionMessage[]> = []
    let spawned: Awaited<ReturnType<typeof spawnInProcessTeammate>> | undefined
    const precursor = setTimeout(() => console.log('PM1 precursor ' + JSON.stringify({
      coreCalls:modelCalls.map(input=>({source:input.options.querySource,agentId:input.options.agentId})), closed,
      events:events.map(event=>({event:event.event,agentId:event.input.agentId,turnId:event.input.turnId})),
      liveMessageCounts:liveMessages.map(messages=>messages.length), trace,
      task:spawned?.taskId ? context.getAppState().tasks[spawned.taskId]?.status : undefined,
    })), 1500)
    try {
      await runtime.bind({ cwd: project, sessionId: getSessionId(), surface: null, isInteractive: false })
      const entry = join(fixture, 'session-messages-register.ts')
      await writeFile(entry, `let histories=[]; export function register(on) {
        on('turn.complete',async ($,e,next)=>{histories.push(await $.session.messages({agentId:e.agentId}));return next(e);});
        on('tool.call',()=>({result:histories}));
      }`)
      await runtime.reconcile([{name:'pm1-session-reader',storageId:'pm1-session-reader@inline',pluginRoot:fixture,entrypoints:[entry]}])
      runtime.registerHostHook({
        plugin: 'pm1-teammate', tier: 'user', registration: { id: 1, event: 'turn.start', hasCatch: false },
        invoke: async (input, next) => { events.push({ event: 'turn.start', input }); return next(input) },
      })
      runtime.registerHostHook({
        plugin: 'pm1-teammate', tier: 'user', registration: { id: 2, event: 'turn.step', hasCatch: false },
        invoke: async () => { throw new Error('turn.step requires the real stream consumer') },
        invokeStream: async function* (input, next) {
          events.push({ event: 'turn.step', input })
          const stream = next(input)
          for await (const chunk of stream) yield chunk
          return await stream.result
        },
      })
      runtime.registerHostHook({
        plugin: 'pm1-teammate', tier: 'user', registration: { id: 3, event: 'turn.complete', hasCatch: false },
        invoke: async (input, next) => {
          events.push({ event: 'turn.complete', input })
          if (typeof input.agentId !== 'string') throw new Error('Missing actual teammate agentId')
          const result = await next(input)
          const completions = events.filter(event => event.event === 'turn.complete').length
          if (completions === 1) context.setAppState(previous => {
            const task = previous.tasks[spawned!.taskId!]
            if (!task || task.type !== 'in_process_teammate') throw new Error('No actual live teammate task')
            return { ...previous, tasks: { ...previous.tasks, [task.id]: { ...task, pendingUserMessages: ['second actual prompt'] } } }
          })
          else spawned!.abortController!.abort()
          return result
        },
      })
      spawned = await spawnInProcessTeammate({
        name: 'pm1-real-teammate', teamName: `pm1-team-${randomUUID()}`, prompt: 'first actual prompt',
        planModeRequired: false, permissionMode: 'default', model: 'claude-sonnet-4-6',
      }, context)
      if (!spawned.identity || !spawned.taskId || !spawned.abortController || !spawned.teammateContext)
        throw new Error('Real spawn did not produce a teammate identity')
      expect(spawned.identity.resumableAgentId).toMatch(/^a[\w-]+-[0-9a-f]{16}$/)
      await runInProcessTeammate({
        identity: spawned.identity, taskId: spawned.taskId, prompt: 'first actual prompt',
        model: 'claude-sonnet-4-6', teammateContext: spawned.teammateContext, toolUseContext: context,
        abortController: spawned.abortController,
      })
      const observed = await runtime.dispatch('tool.call', {}, async () => ({result:[]})) as {result:Array<readonly ModSessionMessage[]>}
      liveMessages = observed.result
      expect(modelCalls).toHaveLength(2)
      expect(closed).toBe(2)
      expect(modelCalls.map(input => input.options.querySource)).toEqual(['agent:custom', 'agent:custom'])
      const agentId = spawned.identity.resumableAgentId!
      expect(modelCalls.map(input => String(input.options.agentId))).toEqual([agentId, agentId])
      expect(events.map(event => event.event)).toEqual(['turn.start', 'turn.step', 'turn.complete', 'turn.start', 'turn.step', 'turn.complete'])
      expect(events.map(event => event.input.agentId)).toEqual([agentId, agentId, agentId, agentId, agentId, agentId])
      expect(new Set(events.slice(0, 3).map(event => event.input.turnId)).size).toBe(1)
      expect(new Set(events.slice(3).map(event => event.input.turnId)).size).toBe(1)
      expect(events[0]!.input.turnId).not.toBe(events[3]!.input.turnId)
      expect(events.filter(event => event.event === 'turn.complete').map(event => event.input.reason)).toEqual(['answer', 'answer'])
      expect(JSON.stringify(liveMessages[0])).toContain('FINITE_TEAMMATE_ANSWER_1')
      expect(JSON.stringify(liveMessages[1])).toContain('FINITE_TEAMMATE_ANSWER_1')
      expect(JSON.stringify(liveMessages[1])).toContain('FINITE_TEAMMATE_ANSWER_2')
      await flushSessionStorage()
      const transcript = await getAgentTranscript(asAgentId(agentId))
      expect(transcript?.messages.map(message => message.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
      expect(runtime.activePublicTurnId).toBeUndefined()
    } finally {
      clearTimeout(precursor)
      spawned?.abortController?.abort()
      const task = spawned?.taskId ? context.getAppState().tasks[spawned.taskId] : undefined
      if (task?.type === 'in_process_teammate') task.unregisterCleanup?.()
      await runtime.dispose()
      await flushSessionStorage()
      switchSession(previousSession, previousProject ?? undefined)
      if (previousPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
      else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      resetGitFileWatcher()
      await rm(fixture, { recursive: true, force: true })
    }
    console.log('PM1 actual teammate suite finished')
  }, 20_000)
}
