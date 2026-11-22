import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { UUID } from 'node:crypto'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_PRINT_SDK_EVENT_FLUSH_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('headless SDK events stream during a tool (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-print-sdk-event-flush-test-'))
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
  const sdkEvents = await import('../utils/sdkEventQueue.js')
  const bootstrap = await import('../bootstrap/state.js')
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

  type Write = { type: string; subtype?: string; title?: string; at: number }
  async function runTurn(ask: () => AsyncGenerator<import('../entrypoints/agentSdkTypes.js').SDKMessage>) {
    bootstrap.setIsInteractive(false)
    const writes: Write[] = []
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
        const { subtype, title } = message as { subtype?: string; title?: string }
        writes.push({ type: message.type, subtype, title, at: Date.now() })
      }),
      spyOn(engine, 'ask').mockImplementation(ask),
    ]
    async function* input() {
      yield JSON.stringify({ type: 'user', message: { role: 'user', content: 'FIRST' } }) + '\n'
    }
    let state = getDefaultAppState()
    try {
      await runHeadless(input(), () => state, updater => { state = updater(state) }, [], [], {}, [], {
        outputFormat: 'stream-json', verbose: true, sessionStartHooksPromise: Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
      return writes
    } finally {
      queue.resetCommandQueue()
      for (const mock of mocks) mock.mockRestore()
    }
  }
  const done = { type: 'result', subtype: 'success', is_error: false, result: 'done' } as import('../entrypoints/agentSdkTypes.js').SDKMessage

  // A background agent that finishes while the lead runs a long tool must not
  // wait for that tool: ask() yields nothing until the tool returns.
  test('a task event queued while a tool runs is written before the turn goes on', async () => {
    const writes = await runTurn(async function* () {
      sdkEvents.enqueueSdkEvent({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed', output_file: '', summary: 'bg done' })
      // The lead's tool keeps running.
      await Bun.sleep(600)
      yield done
    })
    const event = writes.find(w => w.subtype === 'task_notification')
    const result = writes.find(w => w.type === 'result')
    expect(event).toBeDefined()
    expect(result).toBeDefined()
    expect(result!.at - event!.at).toBeGreaterThan(400)
  })

  // Official 2.1.329 sends the session's name at startup and after each rename.
  test('a named session sends session_title_changed at startup and on rename', async () => {
    storage.cacheSessionTitle('t1')
    const writes = await runTurn(async function* () {
      await storage.saveCustomTitle(bootstrap.getSessionId() as UUID, 't2')
      yield done
    })
    expect(
      writes.filter(w => w.subtype === 'session_title_changed').map(w => w.title),
    ).toEqual(['t1', 't2'])
    expect(writes[0]).toMatchObject({ subtype: 'session_title_changed', title: 't1' })
  })
}
