import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_PRINT_LATE_NOTIFICATION_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('headless late task notification (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-print-late-notification-test-'))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_IS_COWORK|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_DISABLE_SESSION_PERSISTENCE)/.test(
            key,
          ),
      ),
    )
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
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
      })
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

  // A stopped agent's notification is queued once its abort settles, after the
  // session may already have stopped waiting for it; it must still start a turn.
  test('a task notification queued while the session is idle starts a turn', async () => {
    const prompts: string[] = []
    const firstDone = Promise.withResolvers<void>()
    const noticed = Promise.withResolvers<void>()
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
        if (message.type === 'result' && prompts.length === 1) firstDone.resolve()
      }),
      spyOn(engine, 'ask').mockImplementation(async function* (args) {
        prompts.push(String(args.prompt))
        if (prompts.length === 2) noticed.resolve()
        yield { type: 'result', subtype: 'success', is_error: false, result: 'done' } as import('../entrypoints/agentSdkTypes.js').SDKMessage
      }),
    ]
    async function* input() {
      yield JSON.stringify({ type: 'user', message: { role: 'user', content: 'FIRST' } }) + '\n'
      await firstDone.promise
      // Let the first turn finish and the session go idle.
      await Bun.sleep(300)
      await queue.enqueuePendingNotification({ mode: 'task-notification', value: 'LATE_NOTICE' })
      const woke = await Promise.race([noticed.promise.then(() => true), Bun.sleep(3000).then(() => false)])
      expect(woke).toBe(true)
    }
    let state = getDefaultAppState()
    try {
      await runHeadless(input(), () => state, updater => { state = updater(state) }, [], [], {}, [], {
        outputFormat: 'stream-json', verbose: true, sessionStartHooksPromise: Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
      expect(prompts).toEqual(['FIRST', 'LATE_NOTICE'])
    } finally {
      queue.resetCommandQueue()
      for (const mock of mocks) mock.mockRestore()
    }
  })
}
