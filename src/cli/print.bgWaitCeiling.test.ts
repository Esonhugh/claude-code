import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('headless background wait ceiling (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-print-bg-wait-ceiling-test-'))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_IS_COWORK|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_DISABLE_SESSION_PERSISTENCE|CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS)/.test(
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
  const { createTaskStateBase } = await import('../Task.js')
  const queue = await import('../utils/messageQueueManager.js')
  const inbound = await import('../utils/inboundMessageQueue.js')
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
  type AppState = ReturnType<typeof getDefaultAppState>

  function mockHeadless(onAsk: (prompt: string) => void) {
    return [
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
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async () => {}),
      spyOn(engine, 'ask').mockImplementation(async function* (args) {
        onAsk(String(args.prompt))
        yield { type: 'result', subtype: 'success', is_error: false, result: 'done' } as import('../entrypoints/agentSdkTypes.js').SDKMessage
      }),
    ]
  }

  // A shell whose daemon keeps its output pipe open never finishes on its own.
  function addStuckShell(state: AppState, kill: () => void): AppState {
    const task = {
      ...createTaskStateBase('bstuck', 'local_bash', 'mailman start', 'toolu_stuck'),
      type: 'local_bash' as const,
      status: 'running' as const,
      command: 'mailman start',
      completionStatusSentInAttachment: false,
      shellCommand: { kill, cleanup: () => {} } as never,
      lastReportedTotalLines: 0,
      isBackgrounded: true,
    }
    return { ...state, tasks: { ...state.tasks, [task.id]: task } }
  }

  async function* oneLine(text: string) {
    yield JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
  }

  // Official 2.1.319: after input closes, -p waits at most the ceiling for
  // background tasks, then stops them, lets the model see why, and exits.
  test('stops a background shell still running after the wait ceiling and ends the session', async () => {
    process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '1000'
    const prompts: string[] = []
    let kills = 0
    let state = getDefaultAppState()
    const setState = (updater: (prev: AppState) => AppState) => { state = updater(state) }
    // Like a session with mods, the stop notification reaches the queue a
    // little after the task is killed.
    const unsetReceiver = inbound.setInboundMessageReceiver(async (input, admit) => {
      await Bun.sleep(50)
      await admit(input)
      return { text: input.text }
    })
    const stderr = spyOn(process.stderr, 'write')
    const mocks = mockHeadless(prompt => {
      prompts.push(prompt)
      if (prompts.length === 1) setState(prev => addStuckShell(prev, () => { kills++ }))
    })
    try {
      const run = runHeadless(oneLine('FIRST'), () => state, setState, [], [], {}, [], {
        outputFormat: 'stream-json', verbose: true, sessionStartHooksPromise: Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
      const ended = await Promise.race([run.then(() => true), Bun.sleep(5000).then(() => false)])
      expect(ended).toBe(true)
      expect(kills).toBe(1)
      expect(state.tasks.bstuck?.status).toBe('killed')
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toContain('<status>killed</status>')
      expect(prompts[1]).toContain('was stopped after reaching its background time limit')
      expect(stderr.mock.calls.map(c => String(c[0])).join('')).toContain(
        'Background tasks still running 1s after the last turn (1); stopping them.',
      )
    } finally {
      delete process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS
      unsetReceiver()
      stderr.mockRestore()
      queue.resetCommandQueue()
      for (const mock of mocks) mock.mockRestore()
    }
  }, 15_000)
}
