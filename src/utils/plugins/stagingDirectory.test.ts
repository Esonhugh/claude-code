import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  cleanupPluginPublicationEntry,
  publishDirectory,
} from './stagingDirectory.js'
import { extractZipToDirectory } from './zipCache.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'claude-test-pl4-publish-')),
  )
  roots.push(root)
  return { root, final: join(root, '3.0.0') }
}
async function tree(path: string, value: string) {
  await fs.mkdir(path, { recursive: true })
  await fs.writeFile(join(path, 'value'), value)
}
const value = (path: string) => fs.readFile(join(path, 'value'), 'utf8')
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test('keeps the published version until its replacement is complete', async () => {
  const { root, final } = await fixture()
  await tree(final, 'old')
  const ready = deferred(),
    proceed = deferred()
  let staging = ''
  const publication = publishDirectory(final, async path => {
    staging = path
    await tree(path, 'new')
    ready.resolve()
    await proceed.promise
    await fs.writeFile(join(path, 'last'), 'complete')
  })
  await ready.promise
  try {
    expect(await value(final)).toBe('old')
    expect(existsSync(join(final, 'last'))).toBe(false)
    await cleanupPluginPublicationEntry(
      staging,
      Date.now() + 2 * 60 * 60 * 1000,
    )
    expect(existsSync(staging)).toBe(true)
  } finally {
    proceed.resolve()
  }
  await publication
  expect(await value(final)).toBe('new')
  expect(await fs.readFile(join(final, 'last'), 'utf8')).toBe('complete')
  expect(await fs.readdir(root)).toEqual(['3.0.0'])
})

test('restores the previous version when the publication rename fails', async () => {
  const { root, final } = await fixture()
  await tree(final, 'old')
  const failure = Object.assign(new Error('publication failed'), {
    code: 'EIO',
  })
  const rename = fs.rename
  const stub = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(from).includes('.tmp.') && to === final) throw failure
    return rename(from, to)
  })
  try {
    await expect(
      publishDirectory(final, path => tree(path, 'new')),
    ).rejects.toBe(failure)
  } finally {
    stub.mockRestore()
  }
  expect(await value(final)).toBe('old')
  expect(await fs.readdir(root)).toEqual(['3.0.0'])
})

test('reports both publication and rollback errors and recovers a dead owner backup', async () => {
  const { root, final } = await fixture()
  await tree(final, 'old')
  const failures = [
    new Error('publication failed'),
    new Error('rollback failed'),
  ]
  const rename = fs.rename
  const stub = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === final) throw failures[String(from).includes('.tmp.') ? 0 : 1]
    return rename(from, to)
  })
  let caught: unknown
  try {
    await publishDirectory(final, path => tree(path, 'new'))
  } catch (error) {
    caught = error
  } finally {
    stub.mockRestore()
  }
  expect(caught).toBeInstanceOf(AggregateError)
  expect((caught as AggregateError).errors).toEqual(failures)
  expect(existsSync(final)).toBe(false)
  const entries = await fs.readdir(root)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toContain('.rollback.')
  const dead = Bun.spawn(['/usr/bin/true'])
  await dead.exited
  const backup = `${final}.rollback.${dead.pid}.${randomUUID()}`
  await fs.rename(join(root, entries[0]!), backup)
  await cleanupPluginPublicationEntry(backup, Date.now())
  expect(await value(final)).toBe('old')
  expect(await fs.readdir(root)).toEqual(['3.0.0'])
})

test('serializes competing publishers and exposes complete versions to each', async () => {
  const { root, final } = await fixture()
  await tree(final, 'old')
  const ready = deferred(),
    proceed = deferred()
  const first = publishDirectory(final, async path => {
    await tree(path, 'first')
    ready.resolve()
    await proceed.promise
  })
  await ready.promise
  const second = publishDirectory(final, async path => {
    expect(await value(final)).toBe('first')
    await tree(path, 'second')
  })
  proceed.resolve()
  await Promise.all([first, second])
  expect(await value(final)).toBe('second')
  expect(await fs.readdir(root)).toEqual(['3.0.0'])
})

test('recovers a publication lock after its owner is killed', async () => {
  const { root, final } = await fixture()
  await tree(final, 'old')
  const script = `
    const {publishDirectory} = await import(${JSON.stringify(new URL('./stagingDirectory.ts', import.meta.url).href)});
    const {mkdir} = await import('node:fs/promises');
    await publishDirectory(${JSON.stringify(final)}, async staging => {
      await mkdir(staging);
      process.stdout.write('ready\\n');
      await new Response(Bun.stdin.stream()).text();
    });
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  try {
    const reader = child.stdout.getReader()
    const ready = await reader.read()
    expect(new TextDecoder().decode(ready.value)).toBe('ready\n')
    reader.releaseLock()
  } finally {
    child.kill('SIGKILL')
  }
  await child.exited
  expect(await value(final)).toBe('old')
  await publishDirectory(final, path => tree(path, 'new'))
  expect(await value(final)).toBe('new')
  const abandoned = (await fs.readdir(root)).find(name =>
    name.includes('.tmp.'),
  )!
  expect(abandoned).toContain(`.tmp.${child.pid}.`)
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await fs.utimes(join(root, abandoned), old, old)
  await cleanupPluginPublicationEntry(join(root, abandoned), Date.now())
  expect(await fs.readdir(root)).toEqual(['3.0.0'])
}, 20000)

test('publishes ZIP caches atomically and retains an earlier ZIP after build failure', async () => {
  const { root, final } = await fixture()
  const zip = `${final}.zip`
  await publishDirectory(final, path => tree(path, 'old'), zip)
  const original = await fs.readFile(zip)
  const failure = new Error('incomplete copy')
  await expect(
    publishDirectory(
      final,
      async path => {
        await tree(path, 'partial')
        throw failure
      },
      zip,
    ),
  ).rejects.toBe(failure)
  expect(await fs.readFile(zip)).toEqual(original)
  await publishDirectory(final, path => tree(path, 'new'), zip)
  expect(existsSync(final)).toBe(false)
  expect(await fs.readdir(root)).toEqual(['3.0.0.zip'])
  const extracted = join(root, 'extracted')
  await extractZipToDirectory(zip, extracted)
  expect(await value(extracted)).toBe('new')
})
