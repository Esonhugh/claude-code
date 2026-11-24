import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StdoutMessage } from '../entrypoints/sdk/controlTypes.js'

const childFlag = 'CLAUDE_CODE_MALFORMED_USER_CONTENT_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('stream-json user content that is not a string or an array (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-malformed-user-content-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_TEST_FIXTURES_ROOT: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { runHeadless } = await import('./print.js')
  const { StructuredIO } = await import('./structuredIO.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const { createStore } = await import('../state/store.js')
  const { onChangeAppState } = await import('../state/onChangeAppState.js')
  const bootstrap = await import('../bootstrap/state.js')
  const grove = await import('../services/api/grove.js')
  const growthbook = await import('../services/analytics/growthbook.js')
  const env = await import('../utils/envUtils.js')
  const shutdown = await import('../utils/gracefulShutdown.js')
  const processUtils = await import('../utils/process.js')
  const stdoutGuard = await import('../utils/streamJsonStdoutGuard.js')
  const modelStrings = await import('../utils/model/modelStrings.js')
  const tokenEstimation = await import('../services/tokenEstimation.js')
  const toolPool = await import('../tools.js')
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')
  const engine = await import('../QueryEngine.js')
  const { createAssistantMessage } = await import('../utils/messages.js')

  async function run(message: Record<string, unknown>) {
    const store = createStore(getDefaultAppState(), onChangeAppState)
    const prompts: unknown[] = []
    const frames: StdoutMessage[] = []
    const answered = Promise.withResolvers<void>()
    const mocks = [
      spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env, 'isBareMode').mockReturnValue(true),
      spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
      // get_context_usage counts with the local estimate: behind a proxy that never
      // answers, the count_tokens call would outlast the test.
      spyOn(tokenEstimation, 'countMessagesTokensWithAPI').mockResolvedValue(null),
      spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
      spyOn(engine, 'ask').mockImplementation(async function* (options) {
        prompts.push(options.prompt)
        const assistant = createAssistantMessage({ content: 'done' })
        yield { type: 'assistant', message: assistant.message, parent_tool_use_id: null,
          session_id: bootstrap.getSessionId(), uuid: assistant.uuid }
      }),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async frame => {
        frames.push(frame)
        if (frame.type === 'control_response') answered.resolve()
      }),
    ]
    async function* input() {
      yield JSON.stringify({ type: 'user', message }) + '\n'
      // The reply shows the malformed line is behind us, so the next prompt is its own turn.
      yield JSON.stringify({ type: 'control_request', request_id: 'after', request: { subtype: 'get_context_usage' } }) + '\n'
      await answered.promise
      yield JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' } }) + '\n'
    }
    try {
      await runHeadless(input(), store.getState, store.setState, [], [], {}, [], {
        outputFormat: 'stream-json', verbose: true, sessionStartHooksPromise: Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
    const errors = frames.flatMap(frame => frame.type === 'result' && frame.subtype !== 'success' ? [frame.errors] : [])
    return { prompts, errors }
  }

  for (const content of [123, true, { a: 1 }]) {
    test(`content ${JSON.stringify(content)} is dropped and the next message still runs`, async () => {
      expect(await run({ role: 'user', content })).toEqual({ prompts: ['second'], errors: [] })
    })
  }

  test('content null or absent is an empty prompt, like 2.1.329', async () => {
    expect(await run({ role: 'user', content: null })).toEqual({ prompts: ['', 'second'], errors: [] })
    expect(await run({ role: 'user' })).toEqual({ prompts: ['', 'second'], errors: [] })
  })

  test('content "" still runs a turn', async () => {
    expect(await run({ role: 'user', content: '' })).toEqual({ prompts: ['', 'second'], errors: [] })
  })
}
