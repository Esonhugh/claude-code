import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { ripGrep } = await import('./ripgrep.js')

// Like 2.1.311 a pattern or type ripgrep rejects is an error, not "no matches".
test('a pattern or file type ripgrep rejects is reported, not read as no matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg-usage-'))
  writeFileSync(join(dir, 'a.txt'), 'hi\n')
  const signal = new AbortController().signal
  await expect(ripGrep(['-l', '(unclosed'], dir, signal)).rejects.toThrow(
    /^Search failed — ripgrep rejected the pattern, glob, or file type without searching:\nrg: regex parse error/,
  )
  await expect(ripGrep(['-l', '--type', 'nosuchtype', 'hi'], dir, signal)).rejects.toThrow('rg: unrecognized file type: nosuchtype')
  expect(await ripGrep(['-l', 'zzz'], dir, signal)).toEqual([])
})
