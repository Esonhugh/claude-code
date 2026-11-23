import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import type { UUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const childKey = 'WORKTREE_TRANSCRIPT_TEST_CHILD'

if (!process.env[childKey]) {
  test.each(['resume-from-main', 'relocate', 'enter', 'enter-again', 'resume-again'])(
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
  } else if (process.env[childKey] === 'enter') {
    test('entering a worktree moves the transcript and its tool results there', async () => {
      const { getSessionId, setOriginalCwd } = await import('../bootstrap/state.js')
      const storage = await import('./sessionStorage.js')
      const { getToolResultsDir } = await import('./toolResultStorage.js')
      const { getTaskOutputDir } = await import('./task/diskOutput.js')
      const { createUserMessage, createAssistantMessage } = await import('./messages.js')
      const repo = process.cwd()
      const worktree = join(repo, '.claude', 'worktrees', 'wtK')
      setOriginalCwd(repo)
      const sessionId = getSessionId() as UUID
      await storage.recordTranscript([
        createUserMessage({ content: 'one' }),
        createAssistantMessage({ content: 'FAKE_OK' }),
      ])
      await storage.flushSessionStorage()
      const launchFile = storage.getTranscriptPath()
      const oldResult = join(getToolResultsDir(), 'r1.txt')
      mkdirSync(dirname(oldResult), { recursive: true })
      writeFileSync(oldResult, 'saved output')
      const agentFile = join(dirname(launchFile), sessionId, 'subagents', 'agent-a1.jsonl')
      mkdirSync(dirname(agentFile), { recursive: true })
      writeFileSync(agentFile, '')
      mkdirSync(getTaskOutputDir(), { recursive: true })
      symlinkSync(agentFile, join(getTaskOutputDir(), 'a1.output'))

      // As EnterWorktree does: originalCwd moves first, then the transcript.
      setOriginalCwd(worktree)
      // Appended right before the move and not flushed yet.
      storage.saveWorktreeState({
        originalCwd: repo,
        worktreePath: worktree,
        worktreeName: 'wtK',
        sessionId,
      })
      await storage.relocateSessionTranscript(worktree)
      await storage.flushSessionStorage()

      const moved = join(storage.getProjectDir(worktree), `${sessionId}.jsonl`)
      expect(existsSync(launchFile)).toBe(false)
      expect(storage.getTranscriptPath()).toBe(moved)
      const lines = readFileSync(moved, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(lines.filter(l => l.type === 'relocated')).toEqual([
        { type: 'relocated', sessionId, relocatedCwd: worktree },
      ])
      expect(lines.some(l => l.type === 'worktree-state')).toBe(true)
      // Tool results moved and new ones go next to the transcript.
      expect(getToolResultsDir()).toBe(join(storage.getProjectDir(worktree), sessionId, 'tool-results'))
      expect(readFileSync(join(getToolResultsDir(), 'r1.txt'), 'utf8')).toBe('saved output')
      // A path the conversation already holds is read where the file is now.
      expect(storage.remapFormerSessionPath(oldResult)).toBe(join(getToolResultsDir(), 'r1.txt'))
      expect(storage.remapFormerSessionPath('/elsewhere/r1.txt')).toBe('/elsewhere/r1.txt')
      expect(readlinkSync(join(getTaskOutputDir(), 'a1.output'))).toBe(
        join(storage.getProjectDir(worktree), sessionId, 'subagents', 'agent-a1.jsonl'),
      )
      const log = await storage.getLastSessionLog(sessionId)
      expect(log?.messages.map(m => m.type)).toEqual(['user', 'assistant'])
      expect(log?.fullPath).toBe(moved)
    })
  } else if (process.env[childKey] === 'enter-again') {
    test('a transcript already at the destination is set aside, and a repeat move changes nothing', async () => {
      const { getSessionId, setOriginalCwd } = await import('../bootstrap/state.js')
      const storage = await import('./sessionStorage.js')
      const { createUserMessage, createAssistantMessage } = await import('./messages.js')
      const repo = process.cwd()
      const worktree = join(repo, '.claude', 'worktrees', 'wtK')
      setOriginalCwd(repo)
      const sessionId = getSessionId() as UUID
      await storage.recordTranscript([
        createUserMessage({ content: 'one' }),
        createAssistantMessage({ content: 'FAKE_OK' }),
      ])
      await storage.flushSessionStorage()
      // Left behind by an earlier, interrupted move.
      const toDir = storage.getProjectDir(worktree)
      mkdirSync(toDir, { recursive: true })
      writeFileSync(join(toDir, `${sessionId}.jsonl`), '{"type":"stale"}\n')

      setOriginalCwd(worktree)
      await storage.relocateSessionTranscript(worktree)
      await storage.relocateSessionTranscript(worktree)
      await storage.flushSessionStorage()

      const asides = readdirSync(toDir).filter(n => n.startsWith(`${sessionId}.jsonl.superseded-`))
      expect(asides).toHaveLength(1)
      expect(readFileSync(join(toDir, asides[0]!), 'utf8')).toBe('{"type":"stale"}\n')
      const lines = readFileSync(join(toDir, `${sessionId}.jsonl`), 'utf8').trim().split('\n')
      expect(lines.filter(l => l.includes('"type":"relocated"'))).toHaveLength(1)
      const log = await storage.getLastSessionLog(sessionId)
      expect(log?.messages.map(m => m.type)).toEqual(['user', 'assistant'])
    })
  } else if (process.env[childKey] === 'resume-again') {
    test('resuming and exiting again does not stack relocated or worktree-state entries', async () => {
      const { getSessionId, setOriginalCwd } = await import('../bootstrap/state.js')
      const storage = await import('./sessionStorage.js')
      const { createUserMessage, createAssistantMessage } = await import('./messages.js')
      const repo = process.cwd()
      const worktree = join(repo, '.claude', 'worktrees', 'wtK')
      setOriginalCwd(repo)
      const sessionId = getSessionId() as UUID
      await storage.recordTranscript([
        createUserMessage({ content: 'one' }),
        createAssistantMessage({ content: 'FAKE_OK' }),
      ])
      await storage.flushSessionStorage()
      const worktreeSession = { originalCwd: repo, worktreePath: worktree, worktreeName: 'wtK', sessionId }
      setOriginalCwd(worktree)
      storage.saveWorktreeState(worktreeSession)
      await storage.relocateSessionTranscript(worktree)
      await storage.flushSessionStorage()
      storage.reAppendSessionMetadata()

      // Two resume-then-exit rounds, each starting from what is on disk.
      for (let round = 0; round < 2; round++) {
        storage.clearSessionMetadata()
        const log = await storage.getLastSessionLog(sessionId)
        storage.restoreSessionMetadata({ sessionId, worktreeSession: log?.worktreeSession })
        storage.adoptResumedSessionFile()
        storage.reAppendSessionMetadata()
      }

      const file = join(storage.getProjectDir(worktree), `${sessionId}.jsonl`)
      const types = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l).type)
      expect(types.filter(t => t === 'relocated')).toHaveLength(1)
      expect(types.filter(t => t === 'worktree-state')).toHaveLength(1)
      const log = await storage.getLastSessionLog(sessionId)
      expect(log?.worktreeSession).toEqual(worktreeSession)
      expect(log?.messages.map(m => m.type)).toEqual(['user', 'assistant'])

      // A change is still written, once.
      storage.saveWorktreeState(null)
      storage.reAppendSessionMetadata()
      const after = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l).type)
      expect(after.filter(t => t === 'worktree-state')).toHaveLength(2)
      expect((await storage.getLastSessionLog(sessionId))?.worktreeSession).toBeNull()
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
