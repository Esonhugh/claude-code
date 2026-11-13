import { expect, test } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyDir } from './pluginLoader.js'

async function plugin(): Promise<{ base: string; src: string; out: string }> {
  const base = await mkdtemp(join(tmpdir(), 'copydir-'))
  const src = join(base, 'plugin')
  await mkdir(join(src, 'commands'), { recursive: true })
  await mkdir(join(src, 'agents'))
  await writeFile(join(src, 'agents', 'y.md'), 'agent')
  await writeFile(join(base, 'secret.txt'), 'secret')
  return { base, src, out: join(base, 'out') }
}

test('drops an absolute symlink that points outside the plugin', async () => {
  const { base, src, out } = await plugin()
  await symlink(join(base, 'secret.txt'), join(src, 'commands', 'leak.md'))
  await copyDir(src, out)
  await expect(lstat(join(out, 'commands', 'leak.md'))).rejects.toThrow()
})

test('drops a relative symlink that climbs out of the plugin', async () => {
  const { src, out } = await plugin()
  await symlink('../../secret.txt', join(src, 'commands', 'leak.md'))
  await copyDir(src, out)
  await expect(lstat(join(out, 'commands', 'leak.md'))).rejects.toThrow()
})

test('drops a broken symlink that points outside the plugin', async () => {
  const { base, src, out } = await plugin()
  await symlink(join(base, 'missing.txt'), join(src, 'commands', 'gone.md'))
  await copyDir(src, out)
  await expect(lstat(join(out, 'commands', 'gone.md'))).rejects.toThrow()
})

test('keeps a link to a sibling directory as a relative in-plugin link', async () => {
  const { src, out } = await plugin()
  await symlink('../agents/y.md', join(src, 'commands', 'x.md'))
  await copyDir(src, out)
  expect(await readlink(join(out, 'commands', 'x.md'))).toBe('../agents/y.md')
  expect(await readFile(join(out, 'commands', 'x.md'), 'utf8')).toBe('agent')
})

test('keeps in-plugin links when the plugin is reached through a symlink', async () => {
  const { base, src } = await plugin()
  await symlink('../agents/y.md', join(src, 'commands', 'x.md'))
  await symlink(src, join(base, 'via'))
  const out = join(base, 'out2')
  await copyDir(join(base, 'via'), out)
  expect(await readlink(join(out, 'commands', 'x.md'))).toBe('../agents/y.md')
})
