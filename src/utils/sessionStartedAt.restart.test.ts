import { expect, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const phase = process.env.SESSION_STARTED_AT_TEST_PHASE
const scenario = process.env.SESSION_STARTED_AT_TEST_SCENARIO
if (!phase) {
  test.each(['resume', 'continue', 'jsonl', 'fork'])(
    'first launch survives independent processes: %s',
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), 'session-start-epoch-restart-'))
      try {
        for (const phase of ['write', 'restore']) {
          const child = Bun.spawn(
            [process.execPath, 'test', import.meta.path],
            {
              cwd: root,
              env: {
                PATH: process.env.PATH,
                HOME: root,
                CLAUDE_CONFIG_DIR: join(root, 'config'),
                TMPDIR: root,
                TEST_ENABLE_SESSION_PERSISTENCE: '1',
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                DISABLE_AUTOUPDATER: '1',
                DISABLE_TELEMETRY: '1',
                DISABLE_ERROR_REPORTING: '1',
                ANTHROPIC_API_KEY: 'mods-test-unused',
                SESSION_STARTED_AT_TEST_PHASE: phase,
                SESSION_STARTED_AT_TEST_SCENARIO: scenario,
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
          if (code !== 0) throw new Error(`${phase}: ${stdout}\n${stderr}`)
          expect(code).toBe(0)
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
} else {
  test('uses the production writer, recovery loader and startup restore', async () => {
    const state = await import('../bootstrap/state.js')
    const storage = await import('./sessionStorage.js')
    state.setOriginalCwd(process.cwd())
    const checkpoint = join(process.cwd(), 'checkpoint.json')
    if (phase === 'write') {
      const startedAt = state.getSessionStartedAt()
      expect(startedAt).toBeNumber()
      state.setCostStateForRestore({
        totalCostUSD: 1.25, totalAPIDuration: 300, totalAPIDurationWithoutRetries: 200,
        totalToolDuration: 100, totalLinesAdded: 3, totalLinesRemoved: 2,
        lastDuration: 0, startTime: startedAt,
        modelUsage: { 'claude-sonnet-4-6': {
          inputTokens: 20, outputTokens: 10, thinkingTokens: 6,
          cacheReadInputTokens: 4, cacheCreationInputTokens: 5, webSearchRequests: 1,
          costUSD: 1.25, contextWindow: 200000, maxOutputTokens: 64000,
        } },
      })
      state.setHasUnknownModelCost()
      const { createUserMessage } = await import('./messages.js')
      await storage.recordTranscript([
        createUserMessage({ content: 'independent epoch restore' }),
      ])
      await storage.flushSessionStorage()
      await writeFile(
        checkpoint,
        JSON.stringify({
          id: state.getSessionId(),
          startedAt,
          path: storage.getTranscriptPath(),
        }),
      )
      return
    }
    const saved = JSON.parse(await readFile(checkpoint, 'utf8')) as {
      id: UUID
      startedAt: number
      path: string
    }
    const freshId = state.getSessionId()
    const freshEpoch = state.getSessionStartedAt()
    expect(freshEpoch!).toBeGreaterThan(saved.startedAt)
    const { loadConversationForResume } =
      await import('./conversationRecovery.js')
    const result = await loadConversationForResume(
      scenario === 'continue' ? undefined : saved.id,
      scenario === 'jsonl' ? saved.path : undefined,
    )
    expect(result?.sessionId).toBe(saved.id)
    expect(result?.startedAt).toBe(saved.startedAt)
    expect(result?.costState?.totalCostUSD).toBe(1.25)
    const { saveCurrentProjectConfig } = await import('./config.js')
    saveCurrentProjectConfig(project => ({ ...project, lastSessionId: saved.id, lastCost: 99 }))
    const { getDefaultAppState } = await import('../state/AppStateStore.js')
    const initialState = getDefaultAppState()
    const { processResumedConversation } = await import('./sessionRestore.js')
    await processResumedConversation(
      result!,
      {
        forkSession: scenario === 'fork',
        transcriptPath: saved.path,
      },
      {
        modeApi: null,
        mainThreadAgentDefinition: undefined,
        agentDefinitions: initialState.agentDefinitions,
        currentCwd: process.cwd(),
        cliAgents: [],
        initialState,
      },
    )
    expect<string>(state.getSessionId()).toBe(
      scenario === 'fork' ? freshId : saved.id,
    )
    expect(state.getSessionStartedAt()).toBe(
      saved.startedAt,
    )
    expect(state.getTotalCostUSD()).toBe(1.25)
    expect(state.getTotalAPIDuration()).toBe(300)
    expect(state.getTotalAPIDurationWithoutRetries()).toBe(200)
    expect(state.getTotalToolDuration()).toBe(100)
    expect(state.getTotalLinesAdded()).toBe(3)
    expect(state.getTotalLinesRemoved()).toBe(2)
    expect(state.hasUnknownModelCost()).toBe(true)
    expect(state.getModelUsage()['claude-sonnet-4-6']?.thinkingTokens).toBe(6)
    await storage.flushSessionStorage()
  })
}
