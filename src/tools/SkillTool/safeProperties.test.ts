import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setOriginalCwd, setProjectRoot } from '../../bootstrap/state.js'
import { clearCommandsCache } from '../../commands.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { SkillTool } from './SkillTool.js'

const root = mkdtempSync(join(tmpdir(), 'skill-safe-'))
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

function writeSkill(name: string, frontmatter: string) {
  const dir = join(root, 'config', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\ndescription: ${name} skill\n${frontmatter}---\nDo ${name}.\n`,
  )
}

async function decide(skill: string) {
  const appState = getDefaultAppState()
  return SkillTool.checkPermissions({ skill }, {
    options: { commands: [] },
    getAppState: () => appState,
  } as never)
}

test('a file-based skill with only safe properties runs without a prompt (official 2.1.318)', async () => {
  writeSkill('greet', '')
  expect((await decide('greet')).behavior).toBe('allow')
})

test('a file-based skill that pre-approves tools still asks', async () => {
  writeSkill('cleanup', 'allowed-tools: Bash(rm:*)\n')
  expect((await decide('cleanup')).behavior).toBe('ask')
})

test('a file-based skill with hooks still asks', async () => {
  writeSkill(
    'hooked',
    'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: "true"\n',
  )
  expect((await decide('hooked')).behavior).toBe('ask')
})
