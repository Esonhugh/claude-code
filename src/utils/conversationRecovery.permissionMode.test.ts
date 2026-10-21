import { expect, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childKey = 'PERMISSION_MODE_RECORD_TEST_CHILD'

if (!process.env[childKey]) {
  test.each(['record', 'invalid'])(
    'permission-mode transcript record: %s',
    async scenario => {
      const root = mkdtempSync(join(tmpdir(), 'permission-mode-record-'))
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
    },
  )
} else {
  test('writes permission-mode records and loads the last one for resume', async () => {
    const { getSessionId, setOriginalCwd } = await import(
      '../bootstrap/state.js'
    )
    const storage = await import('./sessionStorage.js')
    const { createUserMessage, createAssistantMessage } = await import(
      './messages.js'
    )
    const { loadConversationForResume } = await import(
      './conversationRecovery.js'
    )
    setOriginalCwd(process.cwd())
    const sessionId = getSessionId() as UUID

    // Cached before the transcript exists, written when it materializes.
    storage.savePermissionMode('acceptEdits')
    await storage.recordTranscript([
      createUserMessage({ content: 'first prompt' }),
      createAssistantMessage({
        content: [{ type: 'text', text: 'first answer', citations: [] }],
      }),
    ])
    // A mid-session switch is written right away, not only on exit.
    storage.savePermissionMode('plan')
    await storage.flushSessionStorage()

    const records = readFileSync(storage.getTranscriptPath(), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .filter(entry => entry.type === 'permission-mode')
    expect(records.map(entry => entry.permissionMode)).toEqual([
      'acceptEdits',
      'plan',
    ])
    expect(records.every(entry => entry.sessionId === sessionId)).toBe(true)

    if (process.env[childKey] === 'invalid') {
      appendFileSync(
        storage.getTranscriptPath(),
        JSON.stringify({
          type: 'permission-mode',
          permissionMode: 'yolo',
          sessionId,
        }) + '\n',
      )
      const loaded = await loadConversationForResume(sessionId, undefined)
      expect(loaded?.permissionMode).toBe('plan')
      return
    }

    const loaded = await loadConversationForResume(sessionId, undefined)
    expect(loaded?.permissionMode).toBe('plan')
  })
}
