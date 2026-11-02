import { afterAll, expect, test } from 'bun:test'
import { linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' } as MacroGlobals
const { readAgentsFlag } = await import('./loadAgentsDir.js')

const dir = mkdtempSync(join(tmpdir(), 'agents-flag-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const inline = '{"reviewer":{"description":"d","prompt":"p"}}'

// Like 2.1.311, --agents takes inline JSON or, with --print, a file path.
test('inline JSON is used as given in every mode', async () => {
  expect(await readAgentsFlag(` ${inline}`, false)).toEqual({ ok: true, json: ` ${inline}` })
})

test('a file path is read with --print and refused without it', async () => {
  const file = join(dir, 'agents.json')
  writeFileSync(file, inline)
  expect(await readAgentsFlag(file, true)).toEqual({ ok: true, json: inline })
  expect(await readAgentsFlag(file, false)).toMatchObject({ ok: false, error: expect.stringContaining('only with --print') })
})

test('a missing or hard-linked file is refused', async () => {
  expect(await readAgentsFlag(join(dir, 'nope.json'), true)).toMatchObject({ ok: false, error: expect.stringContaining('--agents file not found') })
  const file = join(dir, 'linked.json')
  writeFileSync(file, inline)
  linkSync(file, join(dir, 'other.json'))
  expect(await readAgentsFlag(file, true)).toMatchObject({ ok: false, error: expect.stringContaining('more than one hard link') })
})
