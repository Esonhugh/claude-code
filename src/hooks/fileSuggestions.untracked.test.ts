import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCwdState, getOriginalCwd, setCwdState, setOriginalCwd } from '../bootstrap/state.js'
import { clearFileSuggestionCaches, generateFileSuggestions } from './fileSuggestions.js'

const savedCwd = getCwdState()
const savedOriginalCwd = getOriginalCwd()
let repo: string | undefined

afterEach(() => {
  setCwdState(savedCwd)
  setOriginalCwd(savedOriginalCwd)
  clearFileSuggestionCaches()
  if (repo) rmSync(repo, { recursive: true, force: true })
  repo = undefined
}, 15_000)

test('@ suggestions list untracked files in a repo with no tracked files', async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'file-sugg-untracked-')))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'alpha.ts'), 'x')
  setOriginalCwd(repo)
  setCwdState(repo)
  clearFileSuggestionCaches()

  let names: string[] = []
  for (let i = 0; i < 30 && !names.includes('src/alpha.ts'); i++) {
    names = (await generateFileSuggestions('alpha')).map(s => s.displayText)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  expect(names).toContain('src/alpha.ts')
}, 15_000)
