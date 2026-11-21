import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import type { UUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childKey = 'PRINT_RESUME_WORKTREE_TEST_CHILD'

if (!process.env[childKey]) {
  test.each(['resume', 'continue'])(
    'headless --%s goes back into the worktree the session was in',
    async scenario => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'print-worktree-')))
      try {
        const repo = join(root, 'repo')
        mkdirSync(repo)
        const git = (...args: string[]) =>
          execFileSync('git', args, {
            cwd: repo,
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: 't',
              GIT_AUTHOR_EMAIL: 't@example.com',
              GIT_COMMITTER_NAME: 't',
              GIT_COMMITTER_EMAIL: 't@example.com',
            },
          })
        git('init', '-q')
        git('commit', '-q', '--allow-empty', '-m', 'init')
        git('worktree', 'add', '-q', '.claude/worktrees/wtE')
        const child = Bun.spawn(
          [process.execPath, 'test', '--timeout', '30000', import.meta.path],
          {
            cwd: repo,
            env: {
              PATH: process.env.PATH,
              HOME: root,
              CLAUDE_CONFIG_DIR: join(root, 'config'),
              ANTHROPIC_API_KEY: 'test-only-not-a-real-key',
              TEST_ENABLE_SESSION_PERSISTENCE: '1',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              DISABLE_AUTOUPDATER: '1',
              [childKey]: scenario,
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
        if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
        expect(code).toBe(0)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    60_000,
  )
} else {
  ;(globalThis as typeof globalThis & { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }
  test('the resumed session runs in its worktree', async () => {
    const { getSessionId, regenerateSessionId, setOriginalCwd } = await import(
      '../bootstrap/state.js'
    )
    const storage = await import('../utils/sessionStorage.js')
    const { createUserMessage, createAssistantMessage } = await import(
      '../utils/messages.js'
    )
    const { getCwd } = await import('../utils/cwd.js')
    const { getCurrentWorktreeSession } = await import('../utils/worktree.js')
    const { getDefaultAppState } = await import('../state/AppStateStore.js')
    const { loadInitialMessages } = await import('./print.js')

    // A session that called EnterWorktree and ended without leaving it.
    const repo = process.cwd()
    const worktree = join(repo, '.claude', 'worktrees', 'wtE')
    setOriginalCwd(repo)
    const sessionId = getSessionId() as UUID
    await storage.recordTranscript([
      createUserMessage({ content: 'enter the worktree' }),
      createAssistantMessage({ content: 'FAKE_OK' }),
    ])
    storage.saveWorktreeState({
      originalCwd: repo,
      worktreePath: worktree,
      worktreeName: 'wtE',
      sessionId,
    })
    await storage.flushSessionStorage()
    regenerateSessionId()
    storage.resetProjectForTesting()

    let appState = getDefaultAppState()
    const resume = process.env[childKey] === 'resume'
    const { messages } = await loadInitialMessages(
      f => {
        appState = f(appState)
      },
      {
        continue: !resume,
        teleport: undefined,
        resume: resume ? sessionId : undefined,
        resumeSessionAt: undefined,
        forkSession: false,
        outputFormat: undefined,
        restoredWorkerState: Promise.resolve(null),
      },
    )

    expect(messages.length).toBeGreaterThan(0)
    expect(getSessionId() as string).toBe(sessionId)
    expect(getCwd()).toBe(worktree)
    expect(process.cwd()).toBe(worktree)
    expect(getCurrentWorktreeSession()?.worktreeName).toBe('wtE')
  })
}
