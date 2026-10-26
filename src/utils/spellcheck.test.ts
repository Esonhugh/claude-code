import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findSpellcheckWords,
  parseSpellCheckerBanner,
  parseSpellCheckerLine,
  resolveSpellcheckColor,
  SpellChecker,
  spellCheckerArgs,
} from './spellcheck.js'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('spellcheck protocol', () => {
  test('builds checker args and drops unsafe dictionary names', () => {
    expect(spellCheckerArgs('aspell', 'en_GB')).toEqual([
      '-a',
      '--encoding=utf-8',
      '--sug-mode=ultra',
      '--lang=en_GB',
    ])
    expect(spellCheckerArgs('hunspell', '$(rm -rf ~)')).toEqual(['-a', '-i', 'utf-8'])
  })

  test('parses the banner and response lines', () => {
    expect(
      parseSpellCheckerBanner('@(#) International Ispell Version 3.1.20 (but really Aspell 0.60.8)'),
    ).toBe('aspell')
    expect(parseSpellCheckerBanner('hello')).toBeNull()
    expect(parseSpellCheckerLine('& teh 5 0: the, ten')).toEqual({ type: 'misspelled', word: 'teh' })
    expect(parseSpellCheckerLine('# qzxv 4')).toEqual({ type: 'misspelled', word: 'qzxv' })
    expect(parseSpellCheckerLine('*')).toEqual({ type: 'correct' })
    expect(parseSpellCheckerLine('')).toEqual({ type: 'end' })
  })

  test('skips code spans, code-like tokens, flags and mixed case', () => {
    const text = 'Plese run `teh cmd` with --verbos on src/fooo.ts and camelCase helo.'
    expect(findSpellcheckWords(text).map(w => w.word)).toEqual([
      'Plese',
      'run',
      'with',
      'on',
      'and',
      'helo',
    ])
  })

  test('colors fall back to the theme error color', () => {
    expect(resolveSpellcheckColor(undefined)).toBe('error')
    expect(resolveSpellcheckColor('magenta')).toBe('ansi:magenta')
    expect(resolveSpellcheckColor('rgb(1, 2, 3)')).toBe('rgb(1,2,3)')
    expect(resolveSpellcheckColor('nope')).toBe('error')
  })
})

test('SpellChecker records verdicts from an ispell-compatible process', async () => {
  dir = mkdtempSync(join(tmpdir(), 'spellcheck-'))
  const fake = join(dir, 'fake-ispell')
  // Banner, then for each `^words` line: `& word 1 0: x` for words starting with "z", blank line after.
  writeFileSync(
    fake,
    `#!/bin/sh
echo '@(#) International Ispell Version 3.1.20 (but really Aspell 0.60.8)'
while IFS= read -r line; do
  case "$line" in
    '!') continue ;;
    ^*) for w in \${line#^}; do case "$w" in z*) echo "& $w 1 0: x" ;; esac; done; echo ;;
  esac
done
`,
  )
  chmodSync(fake, 0o755)
  const checker = new SpellChecker(async () => ({ command: fake, args: [] }))
  const done = new Promise<void>(resolve => checker.changed.subscribe(resolve))
  checker.request(['hello', 'zorld'])
  await done
  expect(checker.isMisspelled('hello')).toBe(false)
  expect(checker.isMisspelled('zorld')).toBe(true)
  checker.dispose()
})
