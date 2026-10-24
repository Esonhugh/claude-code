import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getOriginalCwd, setOriginalCwd, setProjectConfigRoot } from '../../bootstrap/state.js'
import { getProjectDirsUpToHome } from '../markdownConfigLoader.js'
import { getSettingsFilePathForSource, getSettingsForSource } from './settings.js'
import { resetSettingsCache } from './settingsCache.js'

const originalCwd = getOriginalCwd()
let root: string | undefined

afterEach(() => {
  setProjectConfigRoot(null)
  setOriginalCwd(originalCwd)
  resetSettingsCache()
  if (root) rmSync(root, { recursive: true, force: true })
})

test('--project-config-root moves project settings and .claude trees off the cwd', () => {
  root = mkdtempSync(join(tmpdir(), 'project-config-root-'))
  const checkout = join(root, 'checkout')
  const worktree = join(root, 'worktree')
  for (const dir of [checkout, worktree]) {
    mkdirSync(join(dir, '.git'), { recursive: true })
    mkdirSync(join(dir, '.claude', 'commands'), { recursive: true })
  }
  writeFileSync(join(checkout, '.claude', 'settings.json'), JSON.stringify({ spinnerTipsEnabled: false }))
  writeFileSync(join(worktree, '.claude', 'settings.json'), JSON.stringify({ spinnerTipsEnabled: true }))
  setOriginalCwd(worktree)
  setProjectConfigRoot(checkout)
  resetSettingsCache()

  expect(getSettingsFilePathForSource('projectSettings')).toBe(join(checkout, '.claude', 'settings.json'))
  expect(getSettingsForSource('projectSettings')?.spinnerTipsEnabled).toBe(false)
  expect(getProjectDirsUpToHome('commands', worktree)).toEqual([join(checkout, '.claude', 'commands')])
})
