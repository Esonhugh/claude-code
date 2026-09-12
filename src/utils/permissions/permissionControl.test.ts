import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import React from 'react'
import type { InitBridgeOptions } from '../../bridge/initReplBridge.js'
import type { ReplBridgeHandle } from '../../bridge/replBridge.js'

const childFlag = 'CLAUDE_CODE_PERMISSION_CONTROL_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('permission control responses (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-permission-control-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT)/.test(key),
    ))
    try {
      const child = Bun.spawn(
        [process.execPath, 'test', '--feature=BRIDGE_MODE', import.meta.path],
        {
          cwd: join(import.meta.dir, '../../..'),
          env: {
            ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
            ANTHROPIC_API_KEY: 'test-only-not-a-real-key',
            DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { setSessionSettingsCache, resetSettingsCache } = await import('../settings/settingsCache.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { PLAN_MODE_DISABLED_MESSAGE } = await import('../planModeV2.js')

  test('SDK rejects disabled Plan entry without false success and remains usable', async () => {
    const { runHeadless } = await import('../../cli/print.js')
    const { StructuredIO } = await import('../../cli/structuredIO.js')
    const grove = await import('../../services/api/grove.js')
    const growthbook = await import('../../services/analytics/growthbook.js')
    const env = await import('../envUtils.js')
    const shutdown = await import('../gracefulShutdown.js')
    const processUtils = await import('../process.js')
    const stdoutGuard = await import('../streamJsonStdoutGuard.js')
    const modelStrings = await import('../model/modelStrings.js')
    const toolPool = await import('../../tools.js')
    const { SandboxManager } = await import('../sandbox/sandbox-adapter.js')
    const engine = await import('../../QueryEngine.js')
    const responses: Array<{ request_id: string; subtype: string; error?: string }> = []
    const transitionErrors: unknown[] = []
    const ask = spyOn(engine, 'ask').mockImplementation(() => {
      throw new Error('control requests must not start a model turn')
    })
    const mocks = [
      ask,
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
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async message => {
        if (message.type === 'control_response') responses.push(message.response)
      }),
    ]
    let state = getDefaultAppState()
    const modes: string[] = []
    async function* input() {
      for (const [id, available, mode] of [
        ['disabled', false, 'plan'],
        ['enabled', true, 'plan'],
        ['already-plan', false, 'plan'],
        ['exit', false, 'default'],
        ['disabled-again', false, 'plan'],
      ] as const) {
        setSessionSettingsCache({ settings: { planModeAvailable: available }, errors: [] })
        yield JSON.stringify({
          type: 'control_request', request_id: id,
          request: { subtype: 'set_permission_mode', mode },
        }) + '\n'
        modes.push(state.toolPermissionContext.mode)
      }
    }
    try {
      await runHeadless(input(), () => state, updater => {
        // Record a thrown transition without leaving the test stream unclosed.
        try { state = updater(state) } catch (error) { transitionErrors.push(error) }
      }, [], [], {}, [], {
        outputFormat: 'stream-json', verbose: true,
        sessionStartHooksPromise: Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
      expect(responses.map(({ request_id, subtype }) => [request_id, subtype])).toEqual([
        ['disabled', 'error'], ['enabled', 'success'], ['already-plan', 'success'],
        ['exit', 'success'], ['disabled-again', 'error'],
      ])
      expect(responses[0]?.error).toBe(PLAN_MODE_DISABLED_MESSAGE)
      expect(responses[4]?.error).toBe(PLAN_MODE_DISABLED_MESSAGE)
      expect(transitionErrors).toEqual([])
      expect(modes).toEqual(['default', 'plan', 'plan', 'default', 'default'])
      expect(ask).not.toHaveBeenCalled()
    } finally {
      for (const mock of mocks) mock.mockRestore()
      resetSettingsCache()
    }
  })

  test('REPL bridge returns a policy verdict and preserves active Plan exit', async () => {
    const init = await import('../../bridge/initReplBridge.js')
    const { useReplBridge } = await import('../../hooks/useReplBridge.js')
    const { render } = await import('../../ink.js')
    const { AppStateProvider, useAppStateStore } = await import('../../state/AppState.js')
    const initialized = Promise.withResolvers<InitBridgeOptions>()
    const handle: ReplBridgeHandle = {
      bridgeSessionId: 'test-local-bridge', environmentId: '', sessionIngressUrl: '',
      writeMessages() {}, writeSdkMessages() {}, sendControlRequest() {},
      sendControlResponse() {}, sendControlCancelRequest() {}, sendResult() {},
      async teardown() {},
    }
    const start = spyOn(init, 'initReplBridge').mockImplementation(async options => {
      initialized.resolve(options!)
      return handle
    })
    let store: ReturnType<typeof useAppStateStore> | undefined
    function Harness() {
      store = useAppStateStore()
      useReplBridge([], () => {}, React.useRef(null), [], 'claude-sonnet-4-6')
      return null
    }
    const stdout = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), {
      columns: 100, rows: 30, isTTY: false,
    })
    let instance: Awaited<ReturnType<typeof render>> | undefined
    setSessionSettingsCache({ settings: { planModeAvailable: false }, errors: [] })
    try {
      instance = await render(React.createElement(AppStateProvider, {
        initialState: { ...getDefaultAppState(), replBridgeEnabled: true, replBridgeOutboundOnly: true },
      } as React.ComponentProps<typeof AppStateProvider>, React.createElement(Harness)), {
        stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false,
      })
      const options = await initialized.promise
      const setMode = options.onSetPermissionMode!
      expect(setMode('plan')).toEqual({ ok: false, error: PLAN_MODE_DISABLED_MESSAGE })
      expect(store!.getState().toolPermissionContext.mode).toBe('default')
      setSessionSettingsCache({ settings: { planModeAvailable: true }, errors: [] })
      expect(setMode('plan')).toEqual({ ok: true })
      expect(store!.getState().toolPermissionContext.mode).toBe('plan')
      setSessionSettingsCache({ settings: { planModeAvailable: false }, errors: [] })
      expect(setMode('plan')).toEqual({ ok: true })
      expect(store!.getState().toolPermissionContext.mode).toBe('plan')
      expect(setMode('default')).toEqual({ ok: true })
      expect(store!.getState().toolPermissionContext.mode).toBe('default')
      expect(setMode('plan')).toEqual({ ok: false, error: PLAN_MODE_DISABLED_MESSAGE })
    } finally {
      instance?.unmount()
      instance?.cleanup()
      start.mockRestore()
      resetSettingsCache()
    }
  })
}
