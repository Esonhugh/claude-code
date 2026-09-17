import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { Writable } from 'node:stream'
import type { Message, MessageOrigin } from '../types/message.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import type { AppState } from '../state/AppStateStore.js'

const childFlag = 'CLAUDE_CODE_PRINT_PEER_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('peer queue and headless provenance (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-print-peer-test-'))
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
        [process.execPath, 'test', '--feature=UDS_INBOX', import.meta.path],
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
  ;(globalThis as typeof globalThis & { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }

  const { QueryEngine, ask } = await import('../QueryEngine.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } =
    await import('../utils/fileStateCache.js')
  const { createAssistantMessage } = await import('../utils/messages.js')
  const queryModule = await import('../query.js')
  const contextModule = await import('../utils/queryContext.js')
  const commandModule = await import('../commands.js')
  const plugins = await import('../utils/plugins/pluginLoader.js')
  const hooks = await import('../utils/hooks.js')
  const attachments = await import('../utils/attachments.js')
  const storage = await import('../utils/sessionStorage.js')
  const fileHistory = await import('../utils/fileHistory.js')
  const inputModule = await import('../utils/processUserInput/processUserInput.js')

  const origin: MessageOrigin = {
    kind: 'peer',
    from: 'uds:///tmp/cc-socks/peer.sock',
    msg_id: '11111111-1111-4111-8111-111111111111',
    name: 'reviewer',
    fromMode: 'prompting',
  }

  const { canBatchWith, joinPromptValues } = await import('./print.js')

  test('batching keeps attributed commands separate and preserves parsing flags', () => {
    const plain: QueuedCommand = { mode: 'prompt', value: 'human input' }
    const peer: QueuedCommand = { ...plain, origin, isMeta: true }
    expect(canBatchWith(peer, { ...plain, isMeta: true })).toBe(false)
    expect(canBatchWith({ ...plain, isMeta: true }, peer)).toBe(false)
    expect(canBatchWith(peer, { ...peer })).toBe(false)
    expect(canBatchWith({ ...plain, origin: { kind: 'human' } }, plain)).toBe(
      false,
    )
    for (const flag of [
      'skipSlashCommands',
      'skipAttachments',
      'isMeta',
    ] as const) {
      expect(canBatchWith({ ...plain, [flag]: true }, plain)).toBe(false)
      expect(canBatchWith(plain, { ...plain, [flag]: true })).toBe(false)
      expect(
        canBatchWith({ ...plain, [flag]: true }, { ...plain, [flag]: true }),
      ).toBe(true)
    }
    expect(canBatchWith(plain, { ...plain, workload: 'other' })).toBe(false)
    expect(canBatchWith(plain, { ...plain, mode: 'task-notification' })).toBe(
      false,
    )
    expect(canBatchWith(plain, undefined)).toBe(false)
    expect(canBatchWith(plain, plain)).toBe(true)
    const stamped = {
      ...plain,
      promptSubmitMetadata: { origin: { kind: 'composer' as const }, wait: true, turnId: 'active-turn' },
    }
    expect(canBatchWith(stamped, plain)).toBe(false)
    expect(canBatchWith(plain, stamped)).toBe(false)
    expect(canBatchWith(stamped, stamped)).toBe(false)
    expect(joinPromptValues(['first', 'second'])).toBe('first\nsecond')
  })

  test.each(['incoming', 'held-at-start'] as const)(
    'headless preserves %s peer input, live permissions, and EOF cleanup',
    async arrival => {
      const { runHeadless } = await import('./print.js')
      const engineModule = await import('../QueryEngine.js')
      const { StructuredIO } = await import('./structuredIO.js')
      const { enqueue, dequeueAllMatching } =
        await import('../utils/messageQueueManager.js')
      const peers = await import('../utils/udsMessaging.js')
      const grove = await import('../services/api/grove.js')
      const growthbook = await import('../services/analytics/growthbook.js')
      const env = await import('../utils/envUtils.js')
      const shutdown = await import('../utils/gracefulShutdown.js')
      const processUtils = await import('../utils/process.js')
      const stdoutGuard = await import('../utils/streamJsonStdoutGuard.js')
      const modelStrings = await import('../utils/model/modelStrings.js')
      const toolPool = await import('../tools.js')
      const { SandboxManager } =
        await import('../utils/sandbox/sandbox-adapter.js')
      const settingsChanges =
        await import('../utils/settings/changeDetector.js')
      const settingsApplication =
        await import('../utils/settings/applySettingsChange.js')
      const turnFinished = Promise.withResolvers<void>()
      const turnStarted = Promise.withResolvers<void>()
      const releaseTurn = Promise.withResolvers<void>()
      const wakeCallbacks: Array<(() => void) | null> = []
      let heldCommand: QueuedCommand | undefined
      let releaseOnRefresh = false
      const received: Parameters<typeof ask>[0][] = []
      const permissionClasses: Array<
        ReturnType<typeof peers.getPeerPermissionClass>
      > = []
      const refreshedClasses: Array<
        ReturnType<typeof peers.getPeerPermissionClass>
      > = []
      const refresh = spyOn(
        peers,
        'refreshPeerInboundPolicy',
      ).mockImplementation(() => {
        refreshedClasses.push(peers.getPeerPermissionClass())
        if (releaseOnRefresh && heldCommand) {
          const command = heldCommand
          heldCommand = undefined
          enqueue(command)
          peers.notifyEnqueued()
        }
      })
      const setWake = peers.setOnEnqueue
      const mocks = [
        refresh,
        spyOn(peers, 'setOnEnqueue').mockImplementation(callback => {
          wakeCallbacks.push(callback)
          setWake(callback)
        }),
        spyOn(settingsApplication, 'applySettingsChange').mockImplementation(
          (_source, setState) => {
            setState(state => ({
              ...state,
              toolPermissionContext: {
                ...state.toolPermissionContext,
                isBypassPermissionsModeAvailable: false,
              },
            }))
          },
        ),
        spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
        spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
        spyOn(env, 'isBareMode').mockReturnValue(true),
        spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
        spyOn(
          processUtils,
          'registerProcessOutputErrorHandlers',
        ).mockImplementation(() => {}),
        spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(
          () => () => {},
        ),
        spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(
          undefined,
        ),
        spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
        spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(
          undefined,
        ),
        spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
        spyOn(storage, 'recordQueueOperation').mockResolvedValue(undefined),
        spyOn(StructuredIO.prototype, 'write').mockImplementation(
          async message => {
            if (message.type === 'result') turnFinished.resolve()
          },
        ),
        spyOn(engineModule, 'ask').mockImplementation(async function* (args) {
          received.push(args)
          if (received.length === 1) {
            turnStarted.resolve()
            await releaseTurn.promise
          }
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'done',
          } as import('../entrypoints/agentSdkTypes.js').SDKMessage
        }),
      ]
      const command: QueuedCommand = {
        mode: 'prompt',
        value: '/peer-input @private-file',
        origin,
        skipSlashCommands: true,
        skipAttachments: true,
        isMeta: true,
        uuid: '33333333-3333-4333-8333-333333333333',
        promptSubmitMetadata: { origin: { kind: 'peer' }, wait: false, turnId: 'receiving-turn' },
      }
      let state = getDefaultAppState()
      if (arrival === 'held-at-start') {
        heldCommand = command
        releaseOnRefresh = true
      }
      async function* input() {
        permissionClasses.push(peers.getPeerPermissionClass())
        state = {
          ...state,
          toolPermissionContext: {
            ...state.toolPermissionContext,
            isBypassPermissionsModeAvailable: true,
          },
        }
        yield JSON.stringify({
          type: 'control_request',
          request_id: 'peer-mode',
          request: {
            subtype: 'set_permission_mode',
            mode: 'bypassPermissions',
          },
        }) + '\n'
        permissionClasses.push(peers.getPeerPermissionClass())
        const refreshCount = refreshedClasses.length
        settingsChanges.notifyChange('userSettings')
        expect(refreshedClasses.length).toBeGreaterThan(refreshCount)
        const settingsOnlyRefreshCount = refreshedClasses.length
        settingsChanges.notifyChange('userSettings')
        expect(refreshedClasses.length).toBeGreaterThan(
          settingsOnlyRefreshCount,
        )
        yield JSON.stringify({
          type: 'control_request',
          request_id: 'peer-default',
          request: { subtype: 'set_permission_mode', mode: 'default' },
        }) + '\n'
        permissionClasses.push(peers.getPeerPermissionClass())
        if (arrival === 'incoming') {
          enqueue(command)
          peers.notifyEnqueued()
        }
        await turnStarted.promise
        heldCommand = {
          ...command,
          uuid: '44444444-4444-4444-8444-444444444444',
        }
        releaseOnRefresh = true
        received[0]!.setAppState(state => ({
          ...state,
          toolPermissionContext: {
            ...state.toolPermissionContext,
            mode: 'bypassPermissions',
          },
        }))
        expect(received).toHaveLength(1)
        releaseTurn.resolve()
        await turnFinished.promise
      }
      try {
        await runHeadless(
          input(),
          () => state,
          updater => {
            state = updater(state)
          },
          [],
          [],
          {},
          [],
          {
            outputFormat: 'stream-json',
            verbose: true,
            sessionStartHooksPromise: Promise.resolve([]),
          } as Parameters<typeof runHeadless>[7],
        )
        expect(received).toHaveLength(2)
        expect(received[1]?.origin).toEqual(origin)
        expect(received[0]).toMatchObject({
          prompt: command.value,
          promptUuid: command.uuid,
          promptSubmitMetadata: command.promptSubmitMetadata,
          origin,
          isMeta: true,
          skipSlashCommands: true,
          skipAttachments: true,
        })
        expect(permissionClasses).toEqual(['prompting', 'bypass', 'prompting'])
        expect(refreshedClasses).toContain('bypass')
        expect(refreshedClasses).toContain('prompting')
        expect(peers.getPeerPermissionClass()).toBeUndefined()
        expect(wakeCallbacks.at(-1)).toBeNull()
        refresh.mockClear()
        settingsChanges.notifyChange('userSettings')
        received[0]!.setAppState(state => ({
          ...state,
          toolPermissionContext: {
            ...state.toolPermissionContext,
            mode: 'default',
          },
        }))
        expect(refresh).not.toHaveBeenCalled()
        const wakeBeforeEof = wakeCallbacks.find(callback => callback !== null)
        expect(wakeBeforeEof).toBeDefined()
        wakeBeforeEof!()
        peers.notifyEnqueued()
        expect(received).toHaveLength(2)
      } finally {
        releaseTurn.resolve()
        peers.setOnEnqueue(null)
        dequeueAllMatching(() => true)
        for (const mock of mocks) mock.mockRestore()
      }
    },
  )

  test('AppStateProvider keeps peer permissions live and releases its subscription on unmount', async () => {
    const { render } = await import('../ink.js')
    const { AppStateProvider, useAppStateStore } =
      await import('../state/AppState.js')
    const peers = await import('../utils/udsMessaging.js')
    const permissionSetup =
      await import('../utils/permissions/permissionSetup.js')
    const refresh = spyOn(peers, 'refreshPeerInboundPolicy')
    const disableBypass = spyOn(
      permissionSetup,
      'isBypassPermissionsModeDisabled',
    ).mockReturnValue(false)
    let store: ReturnType<typeof useAppStateStore> | undefined
    function Harness() {
      store = useAppStateStore()
      return null
    }
    const mounted = Promise.withResolvers<void>()
    function Mounted() {
      React.useEffect(() => {
        mounted.resolve()
      }, [])
      return null
    }
    const stdout = Object.assign(
      new Writable({
        write(_chunk, _encoding, done) {
          done()
        },
      }),
      {
        columns: 100,
        rows: 30,
        isTTY: false,
      },
    )
    peers.setPeerPermissionContext(undefined)
    let instance: Awaited<ReturnType<typeof render>> | undefined
    try {
      instance = await render(
        React.createElement(
          AppStateProvider,
          { initialState: getDefaultAppState() } as React.ComponentProps<
            typeof AppStateProvider
          >,
          React.createElement(Harness),
          React.createElement(Mounted),
        ),
        {
          stdout: stdout as unknown as NodeJS.WriteStream,
          patchConsole: false,
        },
      )
      await mounted.promise
      expect(peers.getPeerPermissionClass()).toBe('prompting')
      store!.setState(state => ({
        ...state,
        toolPermissionContext: {
          ...state.toolPermissionContext,
          mode: 'bypassPermissions',
        },
      }))
      expect(peers.getPeerPermissionClass()).toBe('bypass')
      store!.setState(state => ({
        ...state,
        toolPermissionContext: {
          ...state.toolPermissionContext,
          mode: 'plan',
          isBypassPermissionsModeAvailable: true,
        },
      }))
      refresh.mockClear()
      store!.setState(state => ({
        ...state,
        toolPermissionContext: {
          ...state.toolPermissionContext,
          isBypassPermissionsModeAvailable: false,
        },
      }))
      expect(peers.getPeerPermissionClass()).toBe('prompting')
      expect(refresh).toHaveBeenCalledTimes(1)
      refresh.mockClear()
      store!.setState(state => ({ ...state, verbose: !state.verbose }))
      expect(refresh).not.toHaveBeenCalled()
      instance.unmount()
      instance.cleanup()
      instance = undefined
      expect(peers.getPeerPermissionClass()).toBeUndefined()
      refresh.mockClear()
      store!.setState(state => ({
        ...state,
        toolPermissionContext: {
          ...state.toolPermissionContext,
          mode: 'bypassPermissions',
        },
      }))
      expect(refresh).not.toHaveBeenCalled()
    } finally {
      instance?.unmount()
      instance?.cleanup()
      peers.setPeerPermissionContext(undefined)
      refresh.mockRestore()
      disableBypass.mockRestore()
    }
  })

  test.each(['engine', 'ask'] as const)(
    '%s treats peer slash text as data, skips attachments/hooks, and persists provenance before querying',
    async entry => {
      const transcripts: Message[][] = []
      const queryInputs: Array<{ messages: Message[]; publicTurn?: { text: string } }> = []
      const processInput = inputModule.processUserInput
      const ingress: Parameters<typeof processInput>[0][] = []
      const mocks = [
        spyOn(inputModule, 'processUserInput').mockImplementation(args => {
          ingress.push(args)
          return processInput(args)
        }),
        spyOn(contextModule, 'fetchSystemPromptParts').mockResolvedValue({
          defaultSystemPrompt: [],
          userContext: {},
          systemContext: {},
        }),
        spyOn(commandModule, 'getSlashCommandToolSkills').mockResolvedValue([]),
        spyOn(plugins, 'loadAllPluginsCacheOnly').mockResolvedValue({
          enabled: [],
          disabled: [],
          errors: [],
        }),
        spyOn(fileHistory, 'fileHistoryEnabled').mockReturnValue(false),
        spyOn(storage, 'recordTranscript').mockImplementation(
          async messages => {
            transcripts.push(structuredClone(messages))
            return messages.at(-1)?.uuid
          },
        ),
        spyOn(queryModule, 'query').mockImplementation(
          async function* (params) {
            queryInputs.push(structuredClone({ messages: params.messages, publicTurn: params.publicTurn }))
            yield createAssistantMessage({ content: 'peer received' })
            return { reason: 'completed' }
          },
        ),
      ]
      const hook = spyOn(
        hooks,
        'executeUserPromptSubmitHooks',
      ).mockImplementation(async function* () {})
      const attachment = spyOn(
        attachments,
        'getAttachmentMessages',
      ).mockImplementation(async function* () {})
      let state: AppState = getDefaultAppState()
      const mutableMessages: Message[] = []
      const config = {
        cwd: process.cwd(),
        tools: [],
        commands: [],
        mcpClients: [],
        agents: [],
        canUseTool: async () => ({
          behavior: 'allow' as const,
          updatedInput: {},
        }),
        getAppState: () => state,
        setAppState: (updater: (prev: AppState) => AppState) => {
          state = updater(state)
        },
        initialMessages: mutableMessages,
        readFileCache: createFileStateCacheWithSizeLimit(10),
        userSpecifiedModel: 'claude-sonnet-4-6',
        thinkingConfig: { type: 'disabled' as const },
      }
      const engine = new QueryEngine(config)
      const prompt = '/not-a-local-command @private-file'
      const uuid = '22222222-2222-4222-8222-222222222222'
      const inputOptions = {
        origin,
        promptSubmitMetadata: { origin: { kind: 'peer' as const }, wait: false, turnId: 'submitted-during-turn' },
        skipSlashCommands: true,
        skipAttachments: true,
        isMeta: true,
      }
      try {
        const output = []
        const stream =
          entry === 'engine'
            ? engine.submitMessage(prompt, { uuid, ...inputOptions })
            : ask({
                ...config,
                ...inputOptions,
                prompt,
                promptUuid: uuid,
                mutableMessages,
                getReadFileCache: () => config.readFileCache,
                setReadFileCache: () => {},
              })
        for await (const message of stream) output.push(message)

        expect(queryInputs).toHaveLength(1)
        expect(ingress[0]?.promptSubmitMetadata).toEqual(inputOptions.promptSubmitMetadata)
        expect(queryInputs[0]?.messages[0]).toMatchObject({
          type: 'user',
          uuid,
          origin,
          isMeta: true,
          message: { role: 'user', content: prompt },
        })
        expect(queryInputs[0]?.publicTurn).toEqual({ text: '' })
        expect(transcripts[0]).toEqual(queryInputs[0]?.messages)
        expect(engine.getMessages()[0]).toMatchObject({ origin, isMeta: true })
        expect(hook).not.toHaveBeenCalled()
        expect(attachment).not.toHaveBeenCalled()
        expect(output.at(-1)).toMatchObject({
          type: 'result',
          subtype: 'success',
          result: 'peer received',
        })

        const humanStream =
          entry === 'engine'
            ? engine.submitMessage('human follow-up')
            : ask({
                ...config,
                prompt: 'human follow-up',
                mutableMessages,
                getReadFileCache: () => config.readFileCache,
                setReadFileCache: () => {},
              })
        for await (const message of humanStream) output.push(message)
        expect(queryInputs[1]?.publicTurn).toEqual({ text: 'human follow-up' })
        expect(hook).toHaveBeenCalledTimes(1)
        expect(attachment).toHaveBeenCalledTimes(1)
        const human = engine
          .getMessages()
          .findLast(message => message.type === 'user')
        expect(human?.origin).toBeUndefined()
        expect(human).toMatchObject({ message: { content: 'human follow-up' } })
        expect(engine.getMessages()[0]).toMatchObject({ origin })
      } finally {
        for (const mock of [...mocks, hook, attachment]) mock.mockRestore()
      }
    },
  )
}
