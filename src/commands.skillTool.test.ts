import { expect, test } from 'bun:test'
import { getSkillToolCommands } from './commands.js'

test('SkillTool lists builtin prompt commands the model may invoke, like 2.1.311', async () => {
  const names = (await getSkillToolCommands(process.cwd())).map(cmd => cmd.name)
  expect(names).toContain('init')
  expect(names).toContain('security-review')
  expect(names).not.toContain('insights')
  expect(names).not.toContain('statusline')
  expect(names).not.toContain('goal')
})
