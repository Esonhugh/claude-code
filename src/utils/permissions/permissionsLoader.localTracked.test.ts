import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resetStateForTests,
  setAllowedSettingSources,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import {
  getGlobalConfig,
  getProjectPathForConfig,
  saveGlobalConfig,
} from '../config.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { loadAllPermissionRulesFromDisk } from './permissionsLoader.js'

const dirs: string[] = []

function git(dir: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

function useRepo({ track, trust }: { track: boolean; trust: boolean }): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'local-tracked-')))
  dirs.push(dir)
  git(dir, 'init', '-q')
  mkdirSync(join(dir, '.claude'))
  writeFileSync(
    join(dir, '.claude', 'settings.local.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(curl:*)'], deny: ['Bash(rm:*)'] },
    }),
  )
  if (track) git(dir, 'add', '-f', '.claude/settings.local.json')
  setOriginalCwd(dir)
  getProjectPathForConfig.cache.clear?.()
  saveGlobalConfig(config => ({
    ...config,
    projects: {
      ...config.projects,
      [getProjectPathForConfig()]: {
        ...config.projects?.[getProjectPathForConfig()],
        hasTrustDialogAccepted: trust,
      } as NonNullable<typeof config.projects>[string],
    },
  }))
  setAllowedSettingSources(['localSettings'])
  resetSettingsCache()
  return dir
}

function localRules(): string[] {
  return loadAllPermissionRulesFromDisk()
    .filter(rule => rule.source === 'localSettings')
    .map(rule => `${rule.ruleBehavior}:${rule.ruleValue.toolName}(${rule.ruleValue.ruleContent})`)
}

const originalProjects = getGlobalConfig().projects

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  resetStateForTests()
})

afterEach(() => {
  saveGlobalConfig(config => ({ ...config, projects: originalProjects }))
  getProjectPathForConfig.cache.clear?.()
  resetSettingsCache()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('allow rules from a git-tracked settings.local.json are held back in a workspace without explicit trust', () => {
  useRepo({ track: true, trust: false })
  expect(localRules()).toEqual(['deny:Bash(rm:*)'])
})

test('allow rules from an untracked settings.local.json apply', () => {
  useRepo({ track: false, trust: false })
  expect(localRules()).toEqual(['allow:Bash(curl:*)', 'deny:Bash(rm:*)'])
})

test('allow rules from a git-tracked settings.local.json apply in an explicitly trusted workspace', () => {
  useRepo({ track: true, trust: true })
  expect(localRules()).toEqual(['allow:Bash(curl:*)', 'deny:Bash(rm:*)'])
})
