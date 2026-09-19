import { expect, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childKey = 'SESSION_RESTART_TEST_CHILD'

if (!process.env[childKey]) {
  test.each([
    'metadata',
    'same-timestamp',
    'first-command',
    'conversation',
    'disabled-env',
    'disabled-state',
    'disabled-setting',
    'disabled-test',
  ])('restart persistence: %s', async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'session-restart-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          TEST_ENABLE_SESSION_PERSISTENCE: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          [childKey]: scenario,
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
      expect(code).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
} else {
  test('saves real local-command history for UUID resume', async () => {
    const { getSessionId, setOriginalCwd, setSessionPersistenceDisabled } =
      await import('../bootstrap/state.js')
    const storage = await import('./sessionStorage.js')
    const {
      createCommandInputMessage,
      createUserMessage,
      createAssistantMessage,
    } = await import('./messages.js')
    setOriginalCwd(process.cwd())
    const sessionId = getSessionId() as UUID
    const scenario = process.env[childKey]!
    const first = createCommandInputMessage('/tui fullscreen')
    if (scenario.startsWith('disabled-')) {
      if (scenario === 'disabled-env')
        process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1'
      if (scenario === 'disabled-state') setSessionPersistenceDisabled(true)
      if (scenario === 'disabled-test')
        delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
      if (scenario === 'disabled-setting') {
        const { updateSettingsForSource } =
          await import('./settings/settings.js')
        expect(
          updateSettingsForSource('userSettings', { cleanupPeriodDays: 0 })
            .error,
        ).toBeNull()
      }
      await expect(storage.persistSessionForRestart([first])).rejects.toThrow(
        'Session persistence is disabled',
      )
      expect(existsSync(storage.getTranscriptPath())).toBe(false)
      return
    }
    if (scenario === 'first-command' || scenario === 'conversation') {
      const history =
        scenario === 'conversation'
          ? [
              {
                ...createUserMessage({ content: 'synthetic user input' }),
                timestamp: '2026-09-19T00:00:00.000Z',
              },
              {
                ...createAssistantMessage({
                  content: [
                    { type: 'text', text: 'synthetic answer', citations: [] },
                  ],
                }),
                timestamp: '2026-09-19T00:00:01.000Z',
              },
            ]
          : []
      await storage.recordTranscript(history)
      await storage.persistSessionForRestart([...history, first])
      await storage.persistSessionForRestart([...history, first])
      const restored = await storage.getLastSessionLog(sessionId)
      expect(restored?.messages.map((message) => message.uuid)).toEqual(
        [...history, first].map((message) => message.uuid),
      )
      const entries = readFileSync(storage.getTranscriptPath(), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(entries.filter((entry) => entry.uuid === first.uuid)).toHaveLength(
        1,
      )
      return
    }
    const rename = createCommandInputMessage('/rename restart-marker')
    rename.timestamp = '2026-09-19T00:00:00.000Z'
    const switchInput = createCommandInputMessage('/tui fullscreen')
    switchInput.timestamp =
      process.env[childKey] === 'same-timestamp'
        ? rename.timestamp
        : '2026-09-19T00:00:01.000Z'
    await storage.saveCustomTitle(sessionId, 'restart-marker')
    await storage.saveAgentName(sessionId, 'restart-marker')
    await storage.recordTranscript([rename])
    await storage.flushSessionStorage()
    expect(await storage.getLastSessionLog(sessionId)).toBeNull()

    await storage.persistSessionForRestart([rename, switchInput])

    const restored = await storage.getLastSessionLog(sessionId)
    expect(restored?.messages.map((message) => message.uuid)).toEqual([
      rename.uuid,
      switchInput.uuid,
    ])
    expect(restored?.customTitle).toBe('restart-marker')
    expect(restored?.agentName).toBe('restart-marker')
    expect(
      restored?.messages.every((message) => message.type === 'system'),
    ).toBe(true)
  })
}
