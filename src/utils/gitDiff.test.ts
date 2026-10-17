import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as executor from './execFileNoThrow.js'
import { execFileSync } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
  utimes,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createGitDiffBackend,
  parseGitDiff,
  parseGitNumstat,
  fetchGitDiff,
  fetchGitDiffHunks,
  fetchSingleFileGitDiff,
} from './gitDiff.js'
import * as cwdModule from './cwd.js'
import * as fs from 'fs/promises'

const roots: string[] = []
const realExec = executor.execFileNoThrowWithCwd
let exec: ReturnType<typeof spyOn<typeof executor, 'execFileNoThrowWithCwd'>>
beforeEach(() => {
  exec = spyOn(executor, 'execFileNoThrowWithCwd')
})
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Diff Test',
  GIT_AUTHOR_EMAIL: 'diff@example.invalid',
  GIT_COMMITTER_NAME: 'Diff Test',
  GIT_COMMITTER_EMAIL: 'diff@example.invalid',
}
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
  }).trim()
}
async function repository(commit = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-diff-test-')))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'commit.gpgsign', 'false')
  if (commit) {
    await writeFile(join(root, 'file.txt'), 'before\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'initial')
  }
  return root
}
afterEach(async () => {
  exec.mockRestore()
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

describe('Git diff backend', () => {
  test('reads NUL paths and rename stats before loading only the requested literal body', async () => {
    const root = await repository()
    const names = [
      'space name.txt',
      'tab\tname.txt',
      'line\nname.txt',
      ':(glob)*.txt',
    ]
    for (const name of names) await writeFile(join(root, name), '--old\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'paths')
    for (const name of names) await writeFile(join(root, name), '++new\n')
    git(root, 'mv', 'file.txt', 'renamed\tfile.txt')
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    const outcome = await backend.fetch('uncommitted')
    expect(outcome.kind).toBe('data')
    if (outcome.kind !== 'data') throw new Error('Expected data')
    expect(outcome.data.stats).toEqual({
      filesCount: 5,
      linesAdded: 4,
      linesRemoved: 4,
    })
    expect(outcome.data.files.map(file => file.path)).toEqual(
      expect.arrayContaining(names),
    )
    const renamed = outcome.data.files.find(
      file => file.path === 'renamed\tfile.txt',
    )!
    expect(renamed.renamedFrom).toBe('file.txt')
    for (const name of names) {
      const body = await backend.fetchBody(
        outcome.data,
        outcome.data.files.find(file => file.path === name)!,
      )
      expect(body.status).toBe('ready')
      expect(body.hunks[0]?.lines).toEqual(['---old', '+++new'])
    }
    expect(await backend.fetchBody(outcome.data, renamed)).toMatchObject({
      status: 'no-body',
    })
  })

  test('captures dirty paths on first fetch, dates conservatively and keeps session as HEAD diff', async () => {
    const root = await repository()
    const sessionStartMs = Date.now() - 10_000
    const old = new Date(sessionStartMs - 10_000)
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs,
    }))!
    await writeFile(join(root, 'file.txt'), 'old edit\n')
    await writeFile(join(root, 'old-untracked'), 'old\n')
    for (const name of ['file.txt', 'old-untracked'])
      await utimes(join(root, name), old, old)
    let outcome = await backend.fetch('session')
    if (outcome.kind !== 'data') throw new Error('Expected data')
    expect(
      outcome.data.files.map(file => [file.path, file.isPreSession]),
    ).toEqual([
      ['file.txt', true],
      ['old-untracked', true],
    ])
    expect(
      (await backend.fetchBody(outcome.data, outcome.data.files[0]!)).hunks[0]
        ?.lines,
    ).toEqual(['-before', '+old edit'])
    await writeFile(join(root, 'new-with-old-mtime'), 'new\n')
    await utimes(join(root, 'new-with-old-mtime'), old, old)
    await symlink('old-untracked', join(root, 'link'))
    await writeFile(join(root, 'file.txt'), 'session edit\n')
    outcome = await backend.fetch('session')
    if (outcome.kind !== 'data') throw new Error('Expected data')
    expect(
      outcome.data.files.find(file => file.path === 'file.txt')?.isPreSession,
    ).toBe(false)
    expect(
      outcome.data.files.find(file => file.path === 'new-with-old-mtime')
        ?.isPreSession,
    ).toBe(false)
    expect(
      outcome.data.files.find(file => file.path === 'link')?.isPreSession,
    ).toBe(false)
    const all = await backend.fetch('uncommitted')
    if (all.kind !== 'data') throw new Error('Expected data')
    expect(all.data.files.some(file => file.path === 'old-untracked')).toBe(
      false,
    )
  })

  test('cuts details above 500 files, limits rows to 50 and bodies to bytes and lines', async () => {
    const root = await repository()
    await writeFile(
      join(root, 'file.txt'),
      Array.from({ length: 450 }, (_, i) => `line ${i}\n`).join(''),
    )
    await writeFile(join(root, 'large'), 'x'.repeat(1_000_001))
    await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]))
    await writeFile(join(root, 'empty'), '')
    git(root, 'add', '.')
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    const outcome = await backend.fetch('session')
    if (outcome.kind !== 'data') throw new Error('Expected data')
    for (const [path, status] of [
      ['file.txt', 'truncated'],
      ['large', 'large'],
      ['binary', 'binary'],
      ['empty', 'no-body'],
    ] as const) {
      const body = await backend.fetchBody(
        outcome.data,
        outcome.data.files.find(file => file.path === path)!,
      )
      expect(body.status).toBe(status)
      expect(body.hunks.flatMap(hunk => hunk.lines).length).toBeLessThanOrEqual(
        400,
      )
    }
    for (let i = 0; i < 55; i++)
      await writeFile(join(root, `extra-${i}`), 'a\n')
    git(root, 'add', '.')
    const fifty = await backend.fetch('session')
    if (fifty.kind !== 'data') throw new Error('Expected data')
    expect(fifty.data.files).toHaveLength(50)
    expect(fifty.data.stats.filesCount).toBe(59)
    for (let i = 55; i < 501; i++)
      await writeFile(join(root, `extra-${i}`), 'a\n')
    git(root, 'add', '.')
    const omitted = await backend.fetch('session')
    expect(omitted).toMatchObject({
      kind: 'data',
      data: { detailsOmitted: true, files: [], stats: { filesCount: 505 } },
    })
  })

  test('distinguishes transient operations, abort and unavailable from a valid empty result', async () => {
    const root = await repository()
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    for (const name of [
      'MERGE_HEAD',
      'REBASE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
    ]) {
      await writeFile(join(root, '.git', name), 'busy')
      expect((await backend.fetch('session')).kind).toBe('transient')
      await rm(join(root, '.git', name))
    }
    expect((await backend.fetch('session')).kind).toBe('data')
    expect((await backend.fetch('session', AbortSignal.abort())).kind).toBe(
      'unavailable',
    )
    await rm(join(root, '.git'), { recursive: true })
    expect((await backend.fetch('session')).kind).toBe('unavailable')
  })

  test('supports unborn HEAD and overlays unstaged edits without presenting a stale staged body', async () => {
    const root = await repository(false)
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    expect(await backend.fetch('session')).toMatchObject({
      kind: 'data',
      data: { isUnborn: true, stats: { filesCount: 0 } },
    })
    await writeFile(join(root, 'staged'), 'one\ntwo\n')
    await writeFile(join(root, 'new'), 'untracked\n')
    git(root, 'add', 'staged')
    let outcome = await backend.fetch('session')
    if (outcome.kind !== 'data') throw new Error('Expected data')
    expect(outcome.data.stats).toEqual({
      filesCount: 2,
      linesAdded: 2,
      linesRemoved: 0,
    })
    expect(
      (await backend.fetchBody(outcome.data, outcome.data.files[0]!)).hunks[0]
        ?.lines,
    ).toEqual(['+one', '+two'])
    await writeFile(join(root, 'staged'), 'replacement\n')
    outcome = await backend.fetch('branch')
    if (outcome.kind !== 'data') throw new Error('Expected data')
    expect(outcome.data.stats.linesAdded).toBe(1)
    expect(outcome.data.stalePaths).toEqual(['staged'])
    expect(
      await backend.fetchBody(outcome.data, outcome.data.files[0]!),
    ).toMatchObject({ status: 'no-body' })
  })

  test('branch compares to the default merge-base and labels detached or missing bases honestly', async () => {
    const root = await repository()
    git(root, 'checkout', '-qb', 'feature')
    await writeFile(join(root, 'branch.txt'), 'branch change\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'branch change')
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    const headKey = await backend.headKey()
    const outcome = await backend.fetch('branch')
    expect(outcome).toMatchObject({
      kind: 'data',
      data: {
        source: { kind: 'branch', baseBranch: 'main' },
        stats: { filesCount: 1 },
      },
    })
    if (outcome.kind !== 'data') throw new Error('Expected data')
    expect(
      (await backend.fetchBody(outcome.data, outcome.data.files[0]!)).hunks[0]
        ?.lines,
    ).toEqual(['+branch change'])
    expect(await backend.fetch('uncommitted')).toMatchObject({
      kind: 'data',
      data: { stats: { filesCount: 0 } },
    })
    git(root, 'checkout', '--detach', '-q')
    expect(await backend.headKey()).not.toBe(headKey)
    expect(await backend.fetch('branch')).toMatchObject({
      kind: 'data',
      data: { source: { kind: 'working-tree' }, stats: { filesCount: 0 } },
    })
    git(root, 'checkout', '-q', 'feature')
    git(root, 'branch', '-D', 'main')
    expect(await backend.fetch('branch')).toMatchObject({
      kind: 'data',
      data: { source: { kind: 'working-tree' }, stats: { filesCount: 0 } },
    })
  })

  test('enforces byte and file admission before patch execution and bounds every Git child', async () => {
    const root = await repository()
    await writeFile(join(root, 'file.txt'), 'x'.repeat(1_000_001))
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    const outcome = await backend.fetch('session')
    if (outcome.kind !== 'data') throw new Error('Expected data')
    expect(
      exec.mock.calls.some(
        ([, args]) =>
          args.includes('diff') &&
          !args.includes('--numstat') &&
          !args.includes('--shortstat'),
      ),
    ).toBe(false)
    exec.mockClear()
    expect(
      await backend.fetchBody(outcome.data, outcome.data.files[0]!),
    ).toMatchObject({ status: 'large' })
    expect(exec.mock.calls.some(([, args]) => args.includes('diff'))).toBe(
      false,
    )
    expect(
      await backend.fetchBody(
        { ...outcome.data, detailsOmitted: true },
        outcome.data.files[0]!,
      ),
    ).toMatchObject({ status: 'no-body' })
    expect(
      await backend.fetchBody(outcome.data, {
        ...outcome.data.files[0]!,
        path: 'not-listed',
      }),
    ).toMatchObject({ status: 'unavailable' })
    await backend.fetch('session')
    for (const [, , options] of exec.mock.calls) {
      expect(options).toMatchObject({
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
        cwd: root,
      })
    }
  })

  test('keeps legacy parsers and fetching contracts while fixing NUL and hunk metadata parsing', async () => {
    expect(
      parseGitNumstat('2\t1\tx\ny\0').perFileStats.get('x\ny'),
    ).toMatchObject({ added: 2, removed: 1 })
    const patch =
      'diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n---old\n+++new\n\\ No newline at end of file\n'
    expect(parseGitDiff(patch).get('file')?.[0]?.lines).toEqual([
      '---old',
      '+++new',
      '\\ No newline at end of file',
    ])
    const root = await repository()
    await writeFile(join(root, 'file.txt'), '--new\n')
    await writeFile(join(root, 'old-untracked'), 'new\n')
    await utimes(join(root, 'old-untracked'), new Date(0), new Date(0))
    const cwd = spyOn(cwdModule, 'getCwd').mockReturnValue(root)
    try {
      const stats = await fetchGitDiff()
      expect(stats?.perFileStats.get('old-untracked')).toMatchObject({
        isUntracked: true,
      })
      expect(stats?.hunks.size).toBe(0)
      const bodies = await fetchGitDiffHunks()
      expect(bodies.get('file.txt')?.[0]?.lines).toEqual(['-before', '+--new'])
    } finally {
      cwd.mockRestore()
    }
  })

  test('never turns clipped, malformed or failed stats into clean data; withheld untracked is explicit', async () => {
    const root = await repository()
    await writeFile(join(root, 'file.txt'), 'changed\n')
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    for (const stdout of [
      '1\t1\tfile.txt',
      'garbage\0',
      '0\t0\t\0old\0',
      'x'.repeat(4 * 1024 * 1024) + '\0',
    ]) {
      exec.mockImplementation((file, args, options) =>
        args.includes('--numstat')
          ? Promise.resolve({ code: 0, stdout, stderr: '' })
          : realExec(file, args, options),
      )
      expect((await backend.fetch('session')).kind).toBe('unavailable')
    }
    exec.mockImplementation((file, args, options) =>
      args.includes('--others')
        ? Promise.resolve({
            code: 1,
            stdout: '',
            stderr: '',
            error: 'Command timed out after 5000 milliseconds',
          })
        : realExec(file, args, options),
    )
    expect(await backend.fetch('session')).toMatchObject({
      kind: 'data',
      data: { isUntrackedWithheld: true, stats: { filesCount: 1 } },
    })
    exec.mockImplementation((file, args, options) =>
      args.includes('--numstat')
        ? Promise.resolve({
            code: 1,
            stdout: '',
            stderr: '',
            error: 'Command timed out after 5000 milliseconds',
          })
        : realExec(file, args, options),
    )
    expect((await backend.fetch('session')).kind).toBe('unavailable')
  })

  test('bounds untracked timestamp probes and directory listings', async () => {
    const root = await repository()
    for (let i = 0; i < 505; i++) {
      const directory = join(root, `d${String(i).padStart(3, '0')}`, 'nested')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'file'), 'untracked\n')
    }
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    const stamps = spyOn(fs, 'lstat')
    const listings = spyOn(fs, 'readdir')
    try {
      const outcome = await backend.fetch('session')
      expect(outcome).toMatchObject({
        kind: 'data',
        data: { files: expect.any(Array) },
      })
      expect(stamps.mock.calls.length).toBeLessThanOrEqual(500)
      expect(
        listings.mock.calls.filter(([path]) => !String(path).includes('/.git'))
          .length,
      ).toBe(512)
    } finally {
      stamps.mockRestore()
      listings.mockRestore()
    }
  })

  test('branch resolves newer local merge-base, remote default, unrelated history and transient failures', async () => {
    const root = await repository()
    const initial = git(root, 'rev-parse', 'HEAD')
    git(root, 'update-ref', 'refs/remotes/origin/main', initial)
    git(
      root,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    )
    await writeFile(join(root, 'base'), 'base\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'newer local main')
    const newer = git(root, 'rev-parse', 'HEAD')
    git(root, 'checkout', '-qb', 'feature')
    await writeFile(join(root, 'feature'), 'feature\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'feature')
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    expect(await backend.fetch('branch')).toMatchObject({
      kind: 'data',
      data: { baseRef: newer, stats: { filesCount: 1 } },
    })
    exec.mockImplementation((file, args, options) =>
      args.includes('merge-base')
        ? Promise.resolve({
            code: 1,
            stdout: '',
            stderr: '',
            error: 'Command timed out after 5000 milliseconds',
          })
        : realExec(file, args, options),
    )
    expect((await backend.fetch('branch')).kind).toBe('unavailable')
    exec.mockImplementation(realExec)
    git(root, 'checkout', '--orphan', 'unrelated')
    git(root, 'commit', '-qm', 'unrelated')
    expect(await backend.fetch('branch')).toMatchObject({
      kind: 'data',
      data: { source: { kind: 'working-tree' } },
    })
  })

  test('uses linked-worktree gitdir and preserves no-newline, deletion and mode-only bodies', async () => {
    const root = await repository()
    const worktree = `${root}-linked`
    roots.push(worktree)
    git(root, 'worktree', 'add', '-q', '-b', 'linked', worktree)
    await writeFile(join(worktree, 'file.txt'), 'no newline')
    const backend = (await createGitDiffBackend({
      cwd: worktree,
      sessionStartMs: 0,
    }))!
    let outcome = await backend.fetch('session')
    if (outcome.kind !== 'data') throw new Error('Expected data')
    expect(
      (await backend.fetchBody(outcome.data, outcome.data.files[0]!)).hunks[0]
        ?.lines,
    ).toEqual(['-before', '+no newline', '\\ No newline at end of file'])
    git(worktree, 'checkout', '--', 'file.txt')
    await fs.chmod(join(worktree, 'file.txt'), 0o755)
    outcome = await backend.fetch('session')
    if (outcome.kind !== 'data') throw new Error('Expected data')
    expect(outcome.data.files).toHaveLength(1)
    expect(
      await backend.fetchBody(outcome.data, outcome.data.files[0]!),
    ).toMatchObject({ status: 'no-body' })
    await rm(join(worktree, 'file.txt'))
    outcome = await backend.fetch('session')
    if (outcome.kind !== 'data') throw new Error('Expected data')
    expect(outcome.data.files[0]?.isPreSession).toBe(false)
    expect(
      (await backend.fetchBody(outcome.data, outcome.data.files[0]!)).hunks[0]
        ?.lines,
    ).toEqual(['-before'])
    const directory = git(worktree, 'rev-parse', '--absolute-git-dir')
    await writeFile(join(directory, 'MERGE_HEAD'), 'busy')
    expect((await backend.fetch('session')).kind).toBe('transient')
  })

  test('cancellation during optional untracked loading is not published as partial data', async () => {
    const root = await repository()
    const controller = new AbortController()
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    exec.mockImplementation((file, args, options) => {
      if (args.includes('--others')) controller.abort()
      return realExec(file, args, options)
    })
    expect((await backend.fetch('session', controller.signal)).kind).toBe(
      'unavailable',
    )
  })

  test('pins the resolved HEAD in each snapshot before a later commit changes HEAD', async () => {
    const root = await repository()
    await writeFile(join(root, 'file.txt'), 'changed\n')
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    const before = await backend.headKey()
    const outcome = await backend.fetch('session')
    if (outcome.kind !== 'data') throw new Error('Expected data')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'move HEAD')
    expect(await backend.headKey()).not.toBe(before)
    expect(
      (await backend.fetchBody(outcome.data, outcome.data.files[0]!)).hunks[0]
        ?.lines,
    ).toEqual(['-before', '+changed'])
  })

  test('bounds generated patch bytes and never spawns details after the 500-file cutoff', async () => {
    const root = await repository()
    await writeFile(join(root, 'file.txt'), 'a'.repeat(600_000) + '\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'long base')
    await writeFile(join(root, 'file.txt'), 'b'.repeat(600_000) + '\n')
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    const outcome = await backend.fetch('session')
    if (outcome.kind !== 'data') throw new Error('Expected data')
    expect(
      await backend.fetchBody(outcome.data, outcome.data.files[0]!),
    ).toMatchObject({ status: 'large', hunks: [] })
    const bodyCall = exec.mock.calls.find(
      ([, args]) => args.includes('diff') && args.includes('--'),
    )!
    expect(bodyCall[2]?.maxBuffer).toBe(1_000_001)
    exec.mockClear()
    exec.mockImplementation((file, args, options) =>
      args.includes('--shortstat')
        ? Promise.resolve({
            code: 0,
            stdout: '501 files changed, 501 insertions(+)',
            stderr: '',
          })
        : realExec(file, args, options),
    )
    const omitted = await backend.fetch('session')
    expect(omitted).toMatchObject({
      kind: 'data',
      data: { files: [], detailsOmitted: true },
    })
    expect(
      exec.mock.calls.some(
        ([, args]) => args.includes('--numstat') || args.includes('--others'),
      ),
    ).toBe(false)
  })

  test('unborn session mode keeps the reference session-only untracked scope', async () => {
    const root = await repository(false)
    await writeFile(join(root, 'old'), 'old\n')
    await utimes(join(root, 'old'), new Date(0), new Date(0))
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: Date.now() - 1000,
    }))!
    const outcome = await backend.fetch('session')
    expect(outcome).toMatchObject({
      kind: 'data',
      data: { isUnborn: true, files: [] },
    })
  })

  test('repository and HEAD probe failures remain retryable instead of negative-cached or clean', async () => {
    const root = await repository()
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    exec.mockImplementation((file, args, options) =>
      args.includes('rev-parse')
        ? Promise.resolve({
            code: 1,
            stdout: '',
            stderr: '',
            error: 'Command timed out after 5000 milliseconds',
          })
        : realExec(file, args, options),
    )
    expect((await backend.fetch('session')).kind).toBe('unavailable')
    expect(await backend.headKey()).toBeNull()
    await expect(
      createGitDiffBackend({ cwd: root, sessionStartMs: 0 }),
    ).rejects.toThrow('probe unavailable')
    exec.mockImplementation(realExec)
    expect((await backend.fetch('session')).kind).toBe('data')
  })

  test('preserves the single-file tool diff contract for literal paths and header-like hunk content', async () => {
    const root = await repository()
    const name = ':(glob)*.txt'
    await writeFile(join(root, name), '--old\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'literal file')
    await writeFile(join(root, name), '++new\n')
    const cwd = spyOn(cwdModule, 'getCwd').mockReturnValue(root)
    try {
      expect(await fetchSingleFileGitDiff(join(root, name))).toMatchObject({
        filename: name,
        status: 'modified',
        additions: 1,
        deletions: 1,
        changes: 2,
      })
      await writeFile(join(root, 'untracked'), 'one\ntwo\n')
      expect(
        await fetchSingleFileGitDiff(join(root, 'untracked')),
      ).toMatchObject({ status: 'added', additions: 2, deletions: 0 })
    } finally {
      cwd.mockRestore()
    }
  })

  test('shares one lazy baseline across concurrent fetches and retries a failed body', async () => {
    const root = await repository()
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    expect(exec.mock.calls.some(([, args]) => args.includes('status'))).toBe(
      false,
    )
    await writeFile(join(root, 'file.txt'), 'edit\n')
    const outcomes = await Promise.all([
      backend.fetch('session'),
      backend.fetch('uncommitted'),
    ])
    expect(
      exec.mock.calls.filter(([, args]) => args.includes('status')),
    ).toHaveLength(1)
    const outcome = outcomes[0]!
    if (outcome.kind !== 'data') throw new Error('Expected data')
    exec.mockImplementation((file, args, options) =>
      args.includes('diff') && args.includes('--')
        ? Promise.resolve({
            code: 1,
            stdout: '',
            stderr: '',
            error: 'Command timed out after 5000 milliseconds',
          })
        : realExec(file, args, options),
    )
    expect(
      await backend.fetchBody(outcome.data, outcome.data.files[0]!),
    ).toMatchObject({ status: 'unavailable' })
    exec.mockImplementation(realExec)
    expect(
      await backend.fetchBody(outcome.data, outcome.data.files[0]!),
    ).toMatchObject({ status: 'ready' })
  })

  test('does not generate a patch after its base-size probe times out', async () => {
    const root = await repository()
    await writeFile(join(root, 'file.txt'), 'edit\n')
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    const outcome = await backend.fetch('session')
    if (outcome.kind !== 'data') throw new Error('Expected data')
    exec.mockClear()
    exec.mockImplementation((file, args, options) =>
      args.includes('cat-file')
        ? Promise.resolve({
            code: 1,
            stdout: '',
            stderr: '',
            error: 'Command timed out after 5000 milliseconds',
          })
        : realExec(file, args, options),
    )
    expect(
      await backend.fetchBody(outcome.data, outcome.data.files[0]!),
    ).toMatchObject({ status: 'unavailable' })
    expect(exec.mock.calls.some(([, args]) => args.includes('diff'))).toBe(
      false,
    )
  })

  test('counts failed directory listings against the per-fetch probe budget', async () => {
    const root = await repository()
    const blocked = join(root, 'blocked')
    await mkdir(blocked)
    for (let i = 0; i < 10; i++)
      await writeFile(join(blocked, `file-${i}`), 'new\n')
    const backend = (await createGitDiffBackend({
      cwd: root,
      sessionStartMs: 0,
    }))!
    const original = fs.readdir
    const listing = spyOn(fs, 'readdir').mockImplementation(((
      path: string,
      options: unknown,
    ) => {
      if (String(path) === blocked)
        return Promise.reject(new Error('fixture permission failure'))
      return original(path, options as never)
    }) as typeof fs.readdir)
    try {
      const outcome = await backend.fetch('session')
      expect(outcome.kind).toBe('data')
      expect(
        listing.mock.calls.filter(([path]) => String(path) === blocked),
      ).toHaveLength(1)
    } finally {
      listing.mockRestore()
    }
  })

  test('pins the root from a subdirectory and distinguishes clean from non-repository', async () => {
    const root = await repository()
    await mkdir(join(root, 'nested'))
    const backend = await createGitDiffBackend({
      cwd: join(root, 'nested'),
      sessionStartMs: Date.now(),
    })
    expect(backend?.root).toBe(root)
    expect(await backend!.fetch('uncommitted')).toMatchObject({
      kind: 'data',
      data: { stats: { filesCount: 0 }, files: [] },
    })
    const outside = await mkdtemp(join(tmpdir(), 'git-diff-test-'))
    roots.push(outside)
    expect(
      await createGitDiffBackend({ cwd: outside, sessionStartMs: Date.now() }),
    ).toBeNull()
  })
})
