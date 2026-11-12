import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setOriginalCwd, setProjectRoot } from '../../bootstrap/state.js'
import { clearCommandsCache } from '../../commands.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { SkillTool } from './SkillTool.js'

const root = mkdtempSync(join(tmpdir(), 'skill-rule-names-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
mkdirSync(join(root, 'project'))
setOriginalCwd(join(root, 'project'))
setProjectRoot(join(root, 'project'))

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => clearCommandsCache())

// Directory "diffname", frontmatter name "other-name": the skill can be
// invoked as either name. allowed-tools keeps it from being auto-allowed.
const dir = join(root, 'config', 'skills', 'diffname')
mkdirSync(dir, { recursive: true })
writeFileSync(
  join(dir, 'SKILL.md'),
  '---\nname: other-name\ndescription: diff\nallowed-tools: Bash(echo:*)\n---\nDo it.\n',
)

async function decide(
  skill: string,
  rules: { deny?: string[]; allow?: string[] },
) {
  const appState = getDefaultAppState()
  appState.toolPermissionContext = {
    ...appState.toolPermissionContext,
    alwaysDenyRules: { session: (rules.deny ?? []).map(r => `Skill(${r})`) },
    alwaysAllowRules: { session: (rules.allow ?? []).map(r => `Skill(${r})`) },
  }
  return (
    await SkillTool.checkPermissions({ skill }, {
      options: { commands: [] },
      getAppState: () => appState,
    } as never)
  ).behavior
}

test('a deny rule on any name of a skill blocks every name it can be invoked by (official 2.1.322)', async () => {
  for (const denied of ['diffname', 'other-name', '/other-name', 'diff:*', 'other:*']) {
    for (const invoked of ['diffname', 'other-name', '/other-name']) {
      expect(await decide(invoked, { deny: [denied] })).toBe('deny')
    }
  }
})

test('an allow rule matches the invoked name or the canonical name only (official 2.1.322)', async () => {
  expect(await decide('diffname', { allow: ['diffname'] })).toBe('allow')
  expect(await decide('other-name', { allow: ['diffname'] })).toBe('allow')
  expect(await decide('other-name', { allow: ['other-name'] })).toBe('allow')
  expect(await decide('diffname', { allow: ['other-name'] })).toBe('ask')
})
