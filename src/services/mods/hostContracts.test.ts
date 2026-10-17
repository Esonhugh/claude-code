import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModHostOperations } from './hostOperations.js'

const limit = 4 * 1024 * 1024
let root: string
let controller: AbortController
let host: ReturnType<typeof createModHostOperations>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-host-contracts-'))
  controller = new AbortController()
  host = createModHostOperations({
    storageId: 'host-contracts@fixture',
    cwd: () => root, signal: controller.signal,
  })
})

afterEach(async () => {
  controller.abort()
  await rm(root, { recursive: true, force: true })
})

test('fs.list exposes regular file mtime and zero for directories and every link kind', async () => {
  const file = join(root, 'file')
  await writeFile(file, 'é')
  await utimes(file, new Date(1791080000123), new Date(1791080000123))
  await mkdir(join(root, 'dir'))
  await symlink('file', join(root, 'link'))
  await symlink('dir', join(root, 'dir-link'))
  await symlink('missing', join(root, 'broken'))
  const expectedTime = (await stat(file)).mtimeMs
  expect(expectedTime).toBeGreaterThan(0)
  expect(await host.fs.list()).toEqual([
    { name: 'broken', kind: 'other', size: 0, mtimeMs: 0, isLink: true },
    { name: 'dir', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    { name: 'dir-link', kind: 'other', size: 0, mtimeMs: 0, isLink: true },
    { name: 'file', kind: 'file', size: 2, mtimeMs: expectedTime, isLink: false },
    { name: 'link', kind: 'other', size: 0, mtimeMs: 0, isLink: true },
  ])
})

test.each([
  [0, 0, false, false],
  [limit, limit, false, false],
  [limit + 1, limit, true, false],
  [limit, limit + 1, false, true],
] as const)('process.run reports independent exact byte truncation at stdout=%s stderr=%s', async (stdout, stderr, outTruncated, errTruncated) => {
  const result = await host.process.run([process.execPath, '-e',
    `await Bun.write(Bun.stdout,Buffer.alloc(${stdout},'o'));await Bun.write(Bun.stderr,Buffer.alloc(${stderr},'e'));process.exitCode=7`,
  ])
  expect(result).toEqual({
    exitCode: 7,
    stdout: 'o'.repeat(Math.min(stdout, limit)),
    stderr: 'e'.repeat(Math.min(stderr, limit)),
    isStdoutTruncated: outTruncated,
    isStderrTruncated: errTruncated,
  })
})

test('process.run drops a cut UTF-8 character without conflating pipe truncation', async () => {
  const result = await host.process.run([process.execPath, '-e',
    `await Bun.write(Bun.stdout,'o'.repeat(${limit - 1})+'中');await Bun.write(Bun.stderr,'e'.repeat(${limit - 3})+'中')`,
  ])
  expect(result).toEqual({
    exitCode: 0, stdout: 'o'.repeat(limit - 1), stderr: 'e'.repeat(limit - 3) + '中',
    isStdoutTruncated: true, isStderrTruncated: false,
  })
})
