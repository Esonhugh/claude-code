import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StdoutMessage } from '../entrypoints/sdk/controlTypes.js'

const childFlag = 'CLAUDE_CODE_SDK_SYSTEM_PROMPT_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('initialize accepts the Agent SDK string[] systemPrompt (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-sdk-system-prompt-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=UDS_INBOX', '--feature=KAIROS_CHANNELS', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_TEST_FIXTURES_ROOT: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      console.log(`${stdout}\n${stderr}`.match(/\d+ pass[\s\S]*?Ran [^\n]+/)?.[0])
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
  const toolPool = await import('../tools.js')
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')
  const engine = await import('../QueryEngine.js')
  const { createAssistantMessage } = await import('../utils/messages.js')
  const { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } = await import('../constants/prompts.js')

  async function run(systemPrompt: unknown, extra: Record<string, unknown>[] = []) {
    const store = createStore(getDefaultAppState(), onChangeAppState)
    const prompts: unknown[] = []
    const frames: StdoutMessage[] = []
    const receipts = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
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
      spyOn(engine, 'ask').mockImplementation(async function* (options) {
        prompts.push(options.customSystemPrompt)
        const assistant = createAssistantMessage({ content: 'done' })
        yield { type: 'assistant', message: assistant.message, parent_tool_use_id: null,
          session_id: bootstrap.getSessionId(), uuid: assistant.uuid }
      }),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async message => {
        frames.push(message)
        if (message.type === 'control_response') receipts.get(message.response.request_id)?.resolve()
      }),
    ]
    const requests = [{ subtype: 'initialize', systemPrompt }, ...extra]
    async function* input() {
      for (const [i, request] of requests.entries()) {
        receipts.set(String(i), Promise.withResolvers<void>())
        yield JSON.stringify({ type: 'control_request', request_id: String(i), request }) + '\n'
        await receipts.get(String(i))!.promise
      }
      yield JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n'
    }
    try {
      await runHeadless(input(), store.getState, store.setState, [], [], {}, [], {
        outputFormat: 'stream-json', verbose: true, sessionStartHooksPromise: Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
    const responses = frames.filter(frame => frame.type === 'control_response').map(frame => frame.response)
    return { prompts, responses }
  }

  test('the SDK default [""] keeps the minimal prompt and get_context_usage still answers', async () => {
    const { prompts, responses } = await run([''], [{ subtype: 'get_context_usage' }])
    expect(prompts).toEqual([''])
    expect(responses.map(r => r.subtype)).toEqual(['success', 'success'])
  })

  test('string[] parts are joined without the cache boundary marker', async () => {
    const { prompts } = await run(['STATIC_PART', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'SESSION_PART'])
    expect(prompts).toEqual(['STATIC_PART\n\nSESSION_PART'])
  })

  test('a plain string systemPrompt is still accepted', async () => {
    const { prompts } = await run('PLAIN_PROMPT')
    expect(prompts).toEqual(['PLAIN_PROMPT'])
  })
}
