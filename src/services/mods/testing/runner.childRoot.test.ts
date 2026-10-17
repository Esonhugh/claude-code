import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPluginTests } from './runner.js'

const fixtures: string[] = []
afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true })
})

test.each(['absolute', 'relative', 'symlink'] as const)('passes the canonical %s plugin root to the real child command', async kind => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'mods-child-root-')))
  fixtures.push(fixture)
  const root = join(fixture, 'mod with space')
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await mkdir(join(root, 'tests'))
  await writeFile(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'child-root', version: '1.0.0' }))
  const file = join(root, 'tests/root.test.ts')
  await writeFile(file, "import {test,expect} from 'claude-code/testing'; test('author child loaded',()=>{expect(true).toBe(true)});\n")
  const alias = join(fixture, 'linked mod')
  await symlink(root, alias)
  const input = kind === 'absolute' ? root : relative(process.cwd(), kind === 'relative' ? root : alias)
  let calls = 0
  const result = await runPluginTests(input, {
    childCommand: (receivedFile, canonicalRoot) => {
      calls++
      expect(receivedFile).toBe(file)
      expect(canonicalRoot).toBe(root)
      return [process.execPath, fileURLToPath(new URL('./runner.ts', import.meta.url)), '--child', canonicalRoot, receivedFile]
    },
  })
  expect(calls).toBe(1)
  expect(result.passed).toBe(1)
  expect(result.failed).toBe(0)
  expect(result.files[0]?.tests[0]?.name).toBe('author child loaded')
})
