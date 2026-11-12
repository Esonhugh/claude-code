import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findCommand, getCommands, getSkillToolCommands } from './commands.js'

const root = mkdtempSync(join(tmpdir(), 'skill-tool-commands-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(root, { recursive: true, force: true })
})

function writeSkill(skillsDir: string, name: string, description: string) {
  mkdirSync(join(skillsDir, name), { recursive: true })
  writeFileSync(
    join(skillsDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`,
  )
}

test('SkillTool lists builtin prompt commands the model may invoke, like 2.1.311', async () => {
  const names = (await getSkillToolCommands(process.cwd())).map(cmd => cmd.name)
  expect(names).toContain('init')
  expect(names).toContain('security-review')
  expect(names).not.toContain('insights')
  expect(names).not.toContain('statusline')
  expect(names).not.toContain('goal')
})

test('a user and a project skill with one name are listed once, as the skill the tool runs (official 2.1.318)', async () => {
  const project = join(root, 'project')
  writeSkill(join(root, 'config', 'skills'), 'dup', 'DUP_FROM_USER')
  writeSkill(join(project, '.claude', 'skills'), 'dup', 'DUP_FROM_PROJECT')
  const listed = (await getSkillToolCommands(project)).filter(
    cmd => cmd.name === 'dup',
  )
  expect(listed.map(cmd => cmd.description)).toEqual(['DUP_FROM_USER'])
  expect(findCommand('dup', await getCommands(project))).toBe(listed[0])
})
