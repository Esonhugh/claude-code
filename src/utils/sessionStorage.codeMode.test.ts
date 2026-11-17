import { expect, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childKey = 'CODE_MODE_TRANSCRIPT_TEST_CHILD'

if (!process.env[childKey]) {
  test.each(['codeMode', 'ordinary'])('Code Mode transcript record: %s', async scenario => {
    const root = mkdtempSync(join(tmpdir(), 'code-mode-transcript-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--timeout', '30000', import.meta.path], {
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
  test('keeps or strips the REPL wrapper and round-trips repl-mode', async () => {
    const { getSessionId, setOriginalCwd } = await import('../bootstrap/state.js')
    const storage = await import('./sessionStorage.js')
    const { createUserMessage, createAssistantMessage } = await import('./messages.js')
    const { loadConversationForResume } = await import('./conversationRecovery.js')
    setOriginalCwd(process.cwd())
    const sessionId = getSessionId() as UUID
    const codeMode = process.env[childKey] === 'codeMode'
    storage.saveCodeMode(codeMode)

    const prompt = createUserMessage({ content: 'look at a.txt' })
    const wrapper = createAssistantMessage({
      content: [{ type: 'tool_use', id: 'toolu_repl', name: 'REPL', input: { code: 'await Read({file_path: "a.txt"})' } }] as never,
    })
    const innerUse = createAssistantMessage({
      content: [{ type: 'tool_use', id: 'repl_inner', name: 'Read', input: { file_path: 'a.txt' } }] as never,
      isVirtual: true,
    })
    const innerResult = { ...createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'repl_inner', content: '' }] }), isVirtual: true as const }
    const wrapperResult = createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'toolu_repl', content: '<repl-output>\n<result>hi</result>\n</repl-output>' }],
    })
    await storage.recordTranscript([prompt, wrapper, innerUse, innerResult, wrapperResult])
    await storage.flushSessionStorage()

    const lines = readFileSync(storage.getTranscriptPath(), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const toolUses = lines.flatMap(entry =>
      entry.type === 'assistant' ? entry.message.content.filter((b: { type: string }) => b.type === 'tool_use') : [],
    )
    const virtual = lines.filter(entry => entry.isVirtual === true).map(entry => entry.type)
    if (codeMode) {
      // The wrapper stays, and the inner pair stays virtual: NOT converted to native calls.
      expect(toolUses.map((b: { name: string }) => b.name)).toEqual(['REPL', 'Read'])
      expect(virtual).toEqual(['assistant', 'user'])
    } else {
      // Ordinary transcript: the wrapper goes and the inner call becomes a native one.
      expect(toolUses.map((b: { name: string }) => b.name)).toEqual(['Read'])
      expect(virtual).toEqual([])
    }
    expect(lines.filter(entry => entry.type === 'repl-mode').map(entry => entry.replMode)).toEqual([codeMode])

    // Last wins.
    appendFileSync(storage.getTranscriptPath(), JSON.stringify({ type: 'repl-mode', replMode: !codeMode, sessionId }) + '\n')
    appendFileSync(storage.getTranscriptPath(), JSON.stringify({ type: 'repl-mode', replMode: 'yes', sessionId }) + '\n')
    const { replModes } = await storage.loadTranscriptFile(storage.getTranscriptPath())
    expect(replModes.get(sessionId)).toBe(!codeMode)

    // Resumed with the gate off: a Code Mode session (last record true) gets the reminder.
    const loaded = await loadConversationForResume(sessionId, undefined)
    const reminder = loaded?.messages.find(
      m => m.type === 'user' && typeof m.message.content === 'string' && m.message.content.includes('Do not call REPL or Poll'),
    )
    if (codeMode) {
      expect(loaded?.replMode).toBe(false)
      expect(reminder).toBeUndefined()
    } else {
      expect(loaded?.replMode).toBe(false)
      expect(reminder).toMatchObject({ isMeta: true })
    }
  })
}
