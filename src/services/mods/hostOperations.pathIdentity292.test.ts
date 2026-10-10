import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createModHostOperations } from './hostOperations.js'

// Official 2.1.292: fs.stat({resolve:true}) preserves each hard-link spelling.
// Native CLI evidence: 80 paths, three reads each; the declarations also state
// that hard links keep their own spelling. Bun's default realpath wrapper can
// intermittently return another alias; inject that observed failure deterministically.
for (const selected of ['source', 'hard'] as const) {
  test(`resolved ${selected} retains the requested hard-link identity`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'stat-identity-')))
    let broken: ReturnType<typeof spyOn<typeof fs, 'realpath'>> | undefined
    try {
      const source = join(root, 'source'), hard = join(root, 'hard')
      await fs.writeFile(source, 'abc')
      await fs.link(source, hard)
      const path = join(root, selected), info = await fs.stat(path)
      const host = createModHostOperations({ cwd: () => root, storageId: 'paths@test', signal: new AbortController().signal })
      broken = spyOn(fs, 'realpath').mockResolvedValue(selected === 'hard' ? source : hard)
      expect(await host.fs.stat(selected, { resolve: true })).toEqual({
        kind: 'file', size: 3, mtimeMs: info.mtimeMs, isLink: false, realPath: path,
      })
    } finally {
      broken?.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}

test('symbolic-link resolution follows symlinks and leaves dangling-link metadata intact', async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'stat-symlinks-')))
  try {
    await fs.mkdir(join(root, 'dir'))
    await fs.writeFile(join(root, 'dir/file'), 'abc')
    await fs.symlink('dir', join(root, 'folder'))
    await fs.symlink('folder/file', join(root, 'chain'))
    await fs.symlink('absent', join(root, 'broken'))
    const host = createModHostOperations({ cwd: () => root, storageId: 'paths@test', signal: new AbortController().signal })
    const info = await fs.stat(join(root, 'dir/file'))
    expect(await host.fs.stat('chain', { resolve: true })).toEqual({ kind: 'file', size: 3, mtimeMs: info.mtimeMs, isLink: true, realPath: join(root, 'dir/file') })
    expect(await host.fs.stat('folder/file', { resolve: true })).toEqual({ kind: 'file', size: 3, mtimeMs: info.mtimeMs, isLink: false, realPath: join(root, 'dir/file') })
    const missing = await fs.lstat(join(root, 'broken'))
    expect(await host.fs.stat('broken', { resolve: true })).toEqual({ kind: 'other', size: missing.size, mtimeMs: missing.mtimeMs, isLink: true })
    await expect(host.fs.stat('absent', { resolve: true })).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('resolves parent segments after following relative and absolute symbolic links', async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'stat-parents-')))
  try {
    await fs.mkdir(join(root, 'outer/folder'), { recursive: true })
    await fs.writeFile(join(root, 'outer/file'), 'abc')
    await fs.symlink('outer/folder', join(root, 'pointer'))
    await fs.symlink('pointer/../file', join(root, 'relative'))
    await fs.symlink(`${root}${sep}pointer${sep}..${sep}file`, join(root, 'absolute'))
    const host = createModHostOperations({ cwd: () => root, storageId: 'paths@test', signal: new AbortController().signal })
    const expected = await fs.stat(join(root, 'outer/file'))
    for (const name of ['relative', 'absolute'])
      expect(await host.fs.stat(name, { resolve: true })).toEqual({ kind: 'file', size: 3, mtimeMs: expected.mtimeMs, isLink: true, realPath: join(root, 'outer/file') })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
