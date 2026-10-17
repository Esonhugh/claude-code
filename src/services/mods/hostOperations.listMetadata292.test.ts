import { expect, test } from 'bun:test'
import { lstat, link, mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createModHostOperations, type FsEntry } from './hostOperations.js'

// Official 2.1.292 FsEntry includes file mtimeMs and uses zero for all other kinds.
test('fs.list exposes typed file metadata without following links', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'list-metadata-')))
  try {
    await mkdir(join(root, 'nested/dir'), { recursive: true })
    await writeFile(join(root, 'nested/file'), 'abc')
    await utimes(join(root, 'nested/file'), 1700000000.25, 1700000000.25)
    await link(join(root, 'nested/file'), join(root, 'nested/hard'))
    await symlink('file', join(root, 'nested/file-link'))
    await symlink('dir', join(root, 'nested/dir-link'))
    await symlink('missing', join(root, 'nested/broken'))
    const host = createModHostOperations({ cwd: () => root, storageId: 'list@test', signal: new AbortController().signal })
    const file = await stat(join(root, 'nested/file'))
    const zero: Omit<FsEntry, 'name'> = { kind: 'other', size: 0, mtimeMs: 0, isLink: true }
    const expected: FsEntry[] = [
      { name: 'broken', ...zero },
      { name: 'dir', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: 'dir-link', ...zero },
      { name: 'file', kind: 'file', size: 3, mtimeMs: file.mtimeMs, isLink: false },
      { name: 'file-link', ...zero },
      { name: 'hard', kind: 'file', size: 3, mtimeMs: file.mtimeMs, isLink: false },
    ]
    const entries = await host.fs.list('nested')
    expect(entries).toEqual(expected)
    for (const entry of entries)
      expect(Object.keys(entry)).toEqual(['name', 'kind', 'size', 'mtimeMs', 'isLink'])
    expect(await host.fs.list(join(root, 'nested'))).toEqual(expected)
    expect(await host.fs.list()).toEqual([{ name: 'nested', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }])
    expect((await lstat(join(root, 'nested/file-link'))).isSymbolicLink()).toBe(true)
    await expect(host.fs.list('missing')).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
