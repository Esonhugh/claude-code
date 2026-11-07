import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_PRINT_INTERRUPT_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('headless interrupt receipts (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-print-interrupt-test-'))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_IS_COWORK|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_DISABLE_SESSION_PERSISTENCE)/.test(
            key,
          ),
      ),
    )
    try {
      const child = Bun.spawn(
        [process.execPath, 'test', '--feature=UDS_INBOX', '--feature=KAIROS_CHANNELS', import.meta.path],
        {
          cwd: join(import.meta.dir, '../..'),
          env: {
            ...env,
            [childFlag]: '1',
            HOME: home,
            CLAUDE_CONFIG_DIR: home,
            ANTHROPIC_API_KEY: 'test-only-not-a-real-key',
            DISABLE_TELEMETRY: '1',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      const summary = `${stdout}\n${stderr}`.match(/\d+ pass[\s\S]*?Ran [^\n]+/)
      if (summary) console.log(summary[0])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: { VERSION: string } }).MACRO = { VERSION: 'test' }
  const { runHeadless } = await import('./print.js')
  const engine = await import('../QueryEngine.js')
  const { StructuredIO } = await import('./structuredIO.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const queue = await import('../utils/messageQueueManager.js')
  const grove = await import('../services/api/grove.js')
  const growthbook = await import('../services/analytics/growthbook.js')
  const env = await import('../utils/envUtils.js')
  const shutdown = await import('../utils/gracefulShutdown.js')
  const processUtils = await import('../utils/process.js')
  const stdoutGuard = await import('../utils/streamJsonStdoutGuard.js')
  const modelStrings = await import('../utils/model/modelStrings.js')
  const toolPool = await import('../tools.js')
  const storage = await import('../utils/sessionStorage.js')
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')
  const cleanup = await import('../utils/cleanupRegistry.js')
  const teammateUtils = await import('../utils/teammate.js')
  const mailbox = await import('../utils/teammateMailbox.js')

  test.each(['idle', 'busy'] as const)('interrupt receipt snapshots surviving %s input before draining', async phase => {
    const started = Promise.withResolvers<void>()
    const receipt = Promise.withResolvers<import('../entrypoints/sdk/controlTypes.js').SDKControlResponse>()
    const release = Promise.withResolvers<void>()
    const received: Parameters<typeof engine.ask>[0][] = []
    const mocks = [
      spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env, 'isBareMode').mockReturnValue(true),
      spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
      spyOn(storage, 'recordQueueOperation').mockResolvedValue(undefined),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async message => {
        if (message.type === 'control_response' && message.response.request_id === 'stop') receipt.resolve(message)
      }),
      spyOn(engine, 'ask').mockImplementation(async function* (args) {
        received.push(args)
        if (received.length === 1) {
          started.resolve()
          await release.promise
        }
        yield {type:'result',subtype:'success',is_error:false,result:'done'} as import('../entrypoints/agentSdkTypes.js').SDKMessage
      }),
    ]
    const active = '11111111-1111-4111-8111-111111111111'
    const first = '22222222-2222-4222-8222-222222222222'
    const notification = '33333333-3333-4333-8333-333333333333'
    const urgent = '44444444-4444-4444-8444-444444444444'
    const otherAgent = '55555555-5555-4555-8555-555555555555'
    async function* input() {
      if (phase === 'busy') {
        yield JSON.stringify({type:'user',message:{role:'user',content:'ACTIVE'},uuid:active}) + '\n'
        await started.promise
        queue.enqueue({mode:'prompt',value:'FIRST',uuid:first})
        queue.enqueue({mode:'prompt',value:'NO_UUID'})
        queue.enqueue({mode:'task-notification',value:'NOTICE',uuid:notification})
        queue.enqueue({mode:'prompt',value:'URGENT',uuid:urgent,priority:'now'})
        queue.enqueue({mode:'prompt',value:'OTHER_AGENT',uuid:otherAgent,agentId:'other' as import('../types/ids.js').AgentId})
      }
      yield JSON.stringify({type:'control_request',request_id:'stop',request:{subtype:'interrupt'}}) + '\n'
      const ack = await receipt.promise
      // Official 2.1.292: insertion order, only this agent, no active or absent UUIDs.
      expect(ack.response).toEqual({subtype:'success',request_id:'stop',response:{still_queued:phase === 'busy' ? [first,notification,urgent] : []}})
      if (phase === 'busy') {
        expect(received).toHaveLength(1)
        expect(received[0]!.abortController.signal.aborted).toBe(true)
        expect(queue.getCommandQueue().map(c => c.value)).toEqual(['FIRST','NO_UUID','NOTICE','URGENT','OTHER_AGENT'])
      }
      release.resolve()
    }
    let state = getDefaultAppState()
    try {
      await runHeadless(input(), () => state, updater => { state = updater(state) }, [], [], {}, [], {
        outputFormat:'stream-json',verbose:true,sessionStartHooksPromise:Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
      expect(received.map(args => args.prompt)).toEqual(phase === 'busy' ? ['ACTIVE','URGENT','FIRST\nNO_UUID','NOTICE'] : [])
      expect(queue.getCommandQueue().map(c => c.value)).toEqual(phase === 'busy' ? ['OTHER_AGENT'] : [])
    } finally {
      release.resolve()
      queue.resetCommandQueue()
      for (const mock of mocks) mock.mockRestore()
    }
  })

  test('results count the user sends still queued, like 2.1.311 queued_turn_count', async () => {
    const results: Array<{ queued_turn_count?: number }> = []
    let asks = 0
    const mocks = [
      spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env, 'isBareMode').mockReturnValue(true),
      spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
      spyOn(storage, 'recordQueueOperation').mockResolvedValue(undefined),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async message => {
        if (message.type === 'result') results.push(message as { queued_turn_count?: number })
      }),
      spyOn(engine, 'ask').mockImplementation(async function* () {
        if (asks++ === 0) {
          queue.enqueue({mode:'prompt',value:'NEXT',uuid:'66666666-6666-4666-8666-666666666666'})
          queue.enqueue({mode:'task-notification',value:'NOTICE'})
          queue.enqueue({mode:'prompt',value:'META',isMeta:true})
          queue.enqueue({mode:'prompt',value:'OTHER',agentId:'other' as import('../types/ids.js').AgentId})
        }
        yield {type:'result',subtype:'success',is_error:false,result:'done'} as import('../entrypoints/agentSdkTypes.js').SDKMessage
      }),
    ]
    async function* input() {
      yield JSON.stringify({type:'user',message:{role:'user',content:'FIRST'}}) + '\n'
    }
    let state = getDefaultAppState()
    try {
      await runHeadless(input(), () => state, updater => { state = updater(state) }, [], [], {}, [], {
        outputFormat:'stream-json',verbose:true,sessionStartHooksPromise:Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
      expect(results[0]?.queued_turn_count).toBe(1)
      expect(results.at(-1)?.queued_turn_count).toBe(0)
    } finally {
      queue.resetCommandQueue()
      for (const mock of mocks) mock.mockRestore()
    }
  })

  // An SDK string prompt closes stdin after the first result. With teammates
  // alive the lead must still be asked to shut the team down, like -p text.
  test('input closing while the team-lead poll waits runs the team shutdown turn', async () => {
    const prompts: unknown[] = []
    const firstResult = Promise.withResolvers<void>()
    const mocks = [
      spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env, 'isBareMode').mockReturnValue(true),
      spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
      spyOn(storage, 'recordQueueOperation').mockResolvedValue(undefined),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async message => {
        if (message.type === 'result') firstResult.resolve()
      }),
      spyOn(engine, 'ask').mockImplementation(async function* (args) {
        prompts.push(args.prompt)
        // The shutdown turn: the lead shuts its team down.
        if (prompts.length === 2) state = { ...state, teamContext: undefined }
        yield {type:'result',subtype:'success',is_error:false,result:'done'} as import('../entrypoints/agentSdkTypes.js').SDKMessage
      }),
    ]
    let state: import('../state/AppStateStore.js').AppState = {
      ...getDefaultAppState(),
      teamContext: {
        teamName: 'r5', teamFilePath: '/nonexistent/config.json', leadAgentId: 'team-lead@r5',
        teammates: { 'alice@r5': { name: 'alice', tmuxSessionName: '', tmuxPaneId: 'in-process', cwd: process.cwd(), spawnedAt: 0 } },
      },
    }
    async function* input() {
      yield JSON.stringify({type:'user',message:{role:'user',content:'SPAWN'}}) + '\n'
      await firstResult.promise
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    try {
      await runHeadless(input(), () => state, updater => { state = updater(state) }, [], [], {}, [], {
        outputFormat:'stream-json',verbose:true,sessionStartHooksPromise:Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
      expect(prompts).toHaveLength(2)
      expect(String(prompts[1])).toContain('shut down your team')
    } finally {
      queue.resetCommandQueue()
      for (const mock of mocks) mock.mockRestore()
    }
  })

  // While teammates still work, the lead waits for their reports instead of
  // being told to shut the team down mid-task (it would poll blind for them).
  test('input closing while teammates still work waits for their messages before the shutdown turn', async () => {
    const prompts: unknown[] = []
    const firstResult = Promise.withResolvers<void>()
    let working = true
    let delivered = false
    const mocks = [
      spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env, 'isBareMode').mockReturnValue(true),
      spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
      spyOn(storage, 'recordQueueOperation').mockResolvedValue(undefined),
      spyOn(teammateUtils, 'hasWorkingInProcessTeammates').mockImplementation(() => working),
      spyOn(mailbox, 'markMessagesAsRead').mockResolvedValue(undefined),
      spyOn(mailbox, 'readUnreadMessages').mockImplementation(async () => {
        if (working || delivered) return []
        delivered = true
        return [{ from: 'alice', text: 'alice: fixed dates.py', timestamp: new Date().toISOString(), read: false }]
      }),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async message => {
        if (message.type === 'result') firstResult.resolve()
      }),
      spyOn(engine, 'ask').mockImplementation(async function* (args) {
        prompts.push(args.prompt)
        if (prompts.length === 1) setTimeout(() => { working = false }, 1500)
        // The report turn: the lead shuts its team down.
        if (prompts.length === 2) state = { ...state, teamContext: undefined }
        yield {type:'result',subtype:'success',is_error:false,result:'done'} as import('../entrypoints/agentSdkTypes.js').SDKMessage
      }),
    ]
    let state: import('../state/AppStateStore.js').AppState = {
      ...getDefaultAppState(),
      teamContext: {
        teamName: 'r6', teamFilePath: '/nonexistent/config.json', leadAgentId: 'team-lead@r6',
        teammates: { 'alice@r6': { name: 'alice', tmuxSessionName: '', tmuxPaneId: 'in-process', cwd: process.cwd(), spawnedAt: 0 } },
      },
    }
    async function* input() {
      yield JSON.stringify({type:'user',message:{role:'user',content:'SPAWN'}}) + '\n'
      await firstResult.promise
    }
    try {
      await runHeadless(input(), () => state, updater => { state = updater(state) }, [], [], {}, [], {
        outputFormat:'stream-json',verbose:true,sessionStartHooksPromise:Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
      expect(prompts).toHaveLength(2)
      expect(String(prompts[1])).toContain('alice: fixed dates.py')
      expect(String(prompts[1])).not.toContain('shut down your team')
    } finally {
      queue.resetCommandQueue()
      for (const mock of mocks) mock.mockRestore()
    }
  })

  // A lead model that ignores the shutdown request must not hang -p forever.
  test('teammates left after the shutdown turn are stopped once the team is quiet', async () => {
    const prompts: unknown[] = []
    const firstResult = Promise.withResolvers<void>()
    const stderr: string[] = []
    const mocks = [
      spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env, 'isBareMode').mockReturnValue(true),
      spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
      spyOn(storage, 'recordQueueOperation').mockResolvedValue(undefined),
      spyOn(teammateUtils, 'getTeamShutdownGraceMs').mockReturnValue(50),
      spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr.push(String(chunk)); return true }),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async message => {
        if (message.type === 'result') firstResult.resolve()
      }),
      spyOn(engine, 'ask').mockImplementation(async function* (args) {
        prompts.push(args.prompt)
        // The lead never shuts its team down.
        yield {type:'result',subtype:'success',is_error:false,result:'done'} as import('../entrypoints/agentSdkTypes.js').SDKMessage
      }),
    ]
    let state: import('../state/AppStateStore.js').AppState = {
      ...getDefaultAppState(),
      teamContext: {
        teamName: 'r3', teamFilePath: '/nonexistent/config.json', leadAgentId: 'team-lead@r3',
        teammates: { 'alice@r3': { name: 'alice', tmuxSessionName: '', tmuxPaneId: 'in-process', cwd: process.cwd(), spawnedAt: 0 } },
      },
    }
    async function* input() {
      yield JSON.stringify({type:'user',message:{role:'user',content:'SPAWN'}}) + '\n'
      await firstResult.promise
    }
    try {
      await Promise.race([
        runHeadless(input(), () => state, updater => { state = updater(state) }, [], [], {}, [], {
          outputFormat:'stream-json',verbose:true,sessionStartHooksPromise:Promise.resolve([]),
        } as Parameters<typeof runHeadless>[7]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('runHeadless hung')), 5000)),
      ])
      expect(prompts).toHaveLength(2)
      expect(String(prompts[1])).toContain('shut down your team')
      expect(Object.keys(state.teamContext?.teammates ?? {})).not.toContain('alice@r3')
      expect(stderr.join('')).toContain('did not shut down')
    } finally {
      queue.resetCommandQueue()
      for (const mock of mocks) mock.mockRestore()
    }
  })

  // External SIGINT mid-tool: the abort ends the shell itself, so shutdown has
  // no live shell to wait for and used to exit before the result was written.
  test('external SIGINT during a turn writes its result before cleanup finishes', async () => {
    const stdout: string[] = []
    const cleanedUp = Promise.withResolvers<string>()
    const mocks = [
      spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env, 'isBareMode').mockReturnValue(true),
      spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(shutdown, 'gracefulShutdown').mockImplementation(async () => {
        await cleanup.runCleanupFunctions()
        cleanedUp.resolve(stdout.join(''))
      }),
      spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(processUtils, 'writeToStdout').mockImplementation(text => { stdout.push(text) }),
      spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
      spyOn(storage, 'recordQueueOperation').mockResolvedValue(undefined),
      spyOn(engine, 'ask').mockImplementation(async function* (args) {
        setTimeout(() => process.emit('SIGINT'), 10)
        await new Promise(resolve => args.abortController.signal.addEventListener('abort', resolve))
        // The killed tool's result and the turn's end take a moment.
        await new Promise(resolve => setTimeout(resolve, 50))
        yield {type:'result',subtype:'error_during_execution',is_error:true,errors:[]} as unknown as import('../entrypoints/agentSdkTypes.js').SDKMessage
      }),
    ]
    async function* input() {
      yield JSON.stringify({type:'user',message:{role:'user',content:'LONG TOOL'}}) + '\n'
    }
    // Earlier runs in this process left their own SIGINT handlers behind.
    process.removeAllListeners('SIGINT')
    let state = getDefaultAppState()
    try {
      void runHeadless(input(), () => state, updater => { state = updater(state) }, [], [], {}, [], {
        outputFormat:'text',sessionStartHooksPromise:Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
      expect(await cleanedUp.promise).toBe('Execution error')
    } finally {
      queue.resetCommandQueue()
      for (const mock of mocks) mock.mockRestore()
    }
  })
}
