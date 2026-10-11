import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { StdoutMessage } from '../entrypoints/sdk/controlTypes.js'

const childFlag = 'CLAUDE_CODE_STREAM_STATE_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('remote stream state uses the real headless lifecycle (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-stream-state-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_AUTO_COMPACT|CLAUDE_AUTOCOMPACT|DISABLE_COMPACT|DISABLE_AUTO_COMPACT)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=UDS_INBOX', '--feature=KAIROS_CHANNELS', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      console.log(`${stdout}\n${stderr}`.match(/\d+ pass[\s\S]*?Ran [^\n]+/)?.[0])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { runHeadless } = await import('./print.js')
  const { StructuredIO } = await import('./structuredIO.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const { createStore } = await import('../state/store.js')
  const { onChangeAppState } = await import('../state/onChangeAppState.js')
  const bootstrap = await import('../bootstrap/state.js')
  const { asSessionId } = await import('../types/ids.js')
  const grove = await import('../services/api/grove.js')
  const growthbook = await import('../services/analytics/growthbook.js')
  const env = await import('../utils/envUtils.js')
  const shutdown = await import('../utils/gracefulShutdown.js')
  const processUtils = await import('../utils/process.js')
  const stdoutGuard = await import('../utils/streamJsonStdoutGuard.js')
  const modelStrings = await import('../utils/model/modelStrings.js')
  const toolPool = await import('../tools.js')
  const { SDKMessageSchema } = await import('../entrypoints/sdk/coreSchemas.js')
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')

  for (const mode of ['remote-eof', 'local-eof', 'remote-live', 'remote-disabled-settings', 'remote-percent'] as const) {
    test(`${mode}: snapshots, live changes, reset and disposal`, async () => {
      const frames: StdoutMessage[] = []
      const config = Promise.withResolvers<null>()
      const automatic = Promise.withResolvers<void>()
      const receipts = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
      const store = createStore(getDefaultAppState(), onChangeAppState)
      const originalSession = bootstrap.getSessionId()
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '200000'
      if (mode === 'remote-disabled-settings') {
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
        process.env.DISABLE_AUTO_COMPACT = '1'
        store.setState(s => ({ ...s, autoCompactWindow: 150_000 }))
      }
      if (mode === 'remote-percent') process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '50'
      if (mode.startsWith('remote')) process.env.CLAUDE_CODE_REMOTE = '1'
      else delete process.env.CLAUDE_CODE_REMOTE
      const mocks = [
        spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
        spyOn(growthbook, 'initializeGrowthBook').mockReturnValue(config.promise),
        spyOn(env, 'isBareMode').mockReturnValue(true),
        spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
        spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
        spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
        spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
        spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
        spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
        spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
        spyOn(StructuredIO.prototype, 'write').mockImplementation(async message => {
          frames.push(message)
          if (message.type === 'control_response') receipts.get(message.response.request_id)?.resolve()
          if ((message as { type: string }).type === 'autocompact_state') automatic.resolve()
        }),
      ]
      function control(id: string, subtype: string) {
        receipts.set(id, Promise.withResolvers<void>())
        return JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } }) + '\n'
      }
      async function* input() {
        config.resolve(null)
        if (mode !== 'remote-live') return
        yield control('init', 'initialize')
        await receipts.get('init')!.promise
        await automatic.promise
        // Official keeps the active window separate from live flag-settings churn.
        store.setState(s => ({ ...s, settings: { ...s.settings, autoCompactWindow: 180_000 } }))
        store.setState(s => ({ ...s, goalStatus: { active: true, id: 'goal', prompt: 'ship it', iterations: 0, setAt: 123, tokensAtStart: 11 } }))
        store.setState(s => ({ ...s, goalStatus: { ...s.goalStatus } }))
        store.setState(s => ({ ...s, goalStatus: { active: true, id: 'goal', prompt: 'ship it', iterations: 1, setAt: 123, tokensAtStart: 11, lastReason: 'still working' } }))
        store.setState(s => ({ ...s, goalStatus: { active: false } }))
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
        store.setState(s => ({ ...s, autoCompactWindow: 150_000 }))
        store.setState(s => ({ ...s, settings: { ...s.settings } }))
        bootstrap.switchSession(asSessionId(randomUUID()))
        yield control('barrier', 'mcp_status')
        await receipts.get('barrier')!.promise
      }
      try {
        await runHeadless(input(), store.getState, store.setState, [], [], {}, [], {
          outputFormat: 'stream-json', verbose: true, userSpecifiedModel: 'claude-sonnet-4-6[1m]', sessionStartHooksPromise: Promise.resolve([]),
        } as Parameters<typeof runHeadless>[7])
        const stateFrames = frames.filter(m => ['active_goal', 'autocompact_state'].includes(m.type))
        const values = stateFrames.map(m => {
          const { uuid, session_id, ...body } = m as { uuid: string; session_id: string; type: string; value: unknown }
          expect(SDKMessageSchema().safeParse(m).success).toBe(true)
          expect(uuid).toMatch(/^[0-9a-f-]{36}$/)
          expect(session_id).toMatch(/^[0-9a-f-]{36}$/)
          return body
        })
        // Official 2.1.292 real CLI: integer env 200000 reserves 20000 tokens.
        const initial = [
          { type: 'active_goal', value: null },
          { type: 'autocompact_state', value: { enabled: true, effective_window: 180_000, threshold: 167_000, enforced: true, source: 'env' } },
        ]
        if (mode === 'remote-disabled-settings') {
          initial[1] = { type: 'autocompact_state', value: { enabled: false, effective_window: 980_000, threshold: 967_000, enforced: true, source: 'settings' } }
        } else if (mode === 'remote-percent') {
          initial[1] = { type: 'autocompact_state', value: { enabled: true, effective_window: 180_000, threshold: 90_000, enforced: true, source: 'env' } }
        }
        expect(values).toEqual(mode === 'local-eof' ? [] : mode !== 'remote-live' ? initial : [
          ...initial,
          { type: 'active_goal', value: { condition: 'ship it', iterations: 0, set_at: 123, tokens_at_start: 11 } },
          { type: 'active_goal', value: { condition: 'ship it', iterations: 1, set_at: 123, tokens_at_start: 11, last_reason: 'still working' } },
          { type: 'active_goal', value: null },
          ...Array.from({ length: 2 }, () => ({ type: 'autocompact_state', value: { enabled: true, effective_window: 130_000, threshold: 117_000, enforced: true, source: 'settings' } })),
        ])
        const count = frames.length
        store.setState(s => ({ ...s, goalStatus: { active: true, id: 'late', prompt: 'closed', iterations: 0, setAt: 1 } }))
        expect(frames).toHaveLength(count)
      } finally {
        config.resolve(null)
        bootstrap.switchSession(originalSession)
        delete process.env.DISABLE_AUTO_COMPACT
        delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
        delete process.env.CLAUDE_CODE_REMOTE
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
        for (const mock of mocks) mock.mockRestore()
      }
    })
  }
}
