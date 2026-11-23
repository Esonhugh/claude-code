import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import type { UUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const childKey = 'WORKTREE_TRANSCRIPT_TEST_CHILD'

if (!process.env[childKey]) {
  test.each(['resume-from-main', 'relocate'])(
    'worktree session transcript: %s',
    async scenario => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-transcript-')))
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
        git('worktree', 'add', '-q', '.claude/worktrees/wtK')
        const child = Bun.spawn(
          [process.execPath, 'test', '--timeout', '30000', import.meta.path],
          {
            cwd: repo,
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
  )
} else {
  // A --worktree session: its transcript starts in the worktree's project
  // directory.
  async function recordWorktreeSession() {
    const { getSessionId, regenerateSessionId, setOriginalCwd } = await import(
      '../bootstrap/state.js'
    )
    const storage = await import('./sessionStorage.js')
    const { createUserMessage, createAssistantMessage } = await import('./messages.js')
    const repo = process.cwd()
    const worktree = join(repo, '.claude', 'worktrees', 'wtK')
    setOriginalCwd(worktree)
    const sessionId = getSessionId() as UUID
    await storage.recordTranscript([
      createUserMessage({ content: 'one' }),
      createAssistantMessage({ content: 'FAKE_OK' }),
    ])
    await storage.flushSessionStorage()
    const worktreeFile = storage.getTranscriptPath()
    expect(dirname(worktreeFile)).toBe(storage.getProjectDir(worktree))
    expect(existsSync(worktreeFile)).toBe(true)
    return {
      storage,
      repo,
      sessionId,
      worktreeFile,
      regenerateSessionId,
      setOriginalCwd,
    }
  }

  if (process.env[childKey] === 'resume-from-main') {
    test('--resume <id> from the launch directory finds the worktree session', async () => {
      const {
        storage,
        repo,
        sessionId,
        worktreeFile,
        regenerateSessionId,
        setOriginalCwd,
      } = await recordWorktreeSession()
      // A new process, started in the repository's main checkout.
      regenerateSessionId()
      setOriginalCwd(repo)

      const log = await storage.getLastSessionLog(sessionId)
      expect(log?.messages.map(m => m.type)).toEqual(['user', 'assistant'])
      expect(log?.fullPath).toBe(worktreeFile)
    })
  } else {
    test('leaving the worktree moves the transcript to the launch directory', async () => {
      const { storage, repo, sessionId, worktreeFile } =
        await recordWorktreeSession()
      const sidecar = join(dirname(worktreeFile), sessionId, 'tool-results')
      mkdirSync(sidecar, { recursive: true })

      await storage.relocateSessionTranscript(repo)

      const moved = join(storage.getProjectDir(repo), `${sessionId}.jsonl`)
      expect(existsSync(worktreeFile)).toBe(false)
      expect(existsSync(moved)).toBe(true)
      expect(existsSync(join(storage.getProjectDir(repo), sessionId, 'tool-results'))).toBe(true)
      expect(storage.getTranscriptPath()).toBe(moved)
      expect(storage.sessionIdExists(sessionId)).toBe(true)
      // Later writes follow the transcript.
      storage.saveWorktreeState(null)
      await storage.flushSessionStorage()
      expect(existsSync(worktreeFile)).toBe(false)
      const log = await storage.getLastSessionLog(sessionId)
      expect(log?.messages.map(m => m.type)).toEqual(['user', 'assistant'])
      expect(log?.worktreeSession).toBeNull()
    })
  }
}
