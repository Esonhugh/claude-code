import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerFewerPermissionPromptsSkill } from './fewerPermissionPrompts.js'
import { registerRunSkill, registerRunSkillGeneratorSkill } from './run.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= {
  VERSION: 'test',
}

afterEach(() => clearBundledSkills())

function skill(name: string) {
  const command = getBundledSkills().find(c => c.name === name)
  if (command?.type !== 'prompt') throw new Error(`missing ${name}`)
  return command
}

async function promptText(name: string, args: string): Promise<string> {
  const [block] = await skill(name).getPromptForCommand(args, {} as never)
  return (block as { type: 'text'; text: string }).text
}

test('/run matches the official 2.1.311 bundled skill', async () => {
  registerRunSkill()
  expect(skill('run').disableModelInvocation).toBe(false)
  expect(skill('run').description.startsWith("Launch and drive this project's app to see a change working.")).toBe(true)
  const text = await promptText('run', 'start the server')
  const baseDir = /^Base directory for this skill: (.+)\n\n/.exec(text)?.[1]
  expect(baseDir).toBeDefined()
  expect(text).toContain('\n\n**Running means launching the actual app and interacting with it** -')
  expect(text).not.toContain('name: run\n')
  expect(text.endsWith("captured as a project skill. If it just worked, don't.\n\n\n## User Request\n\nstart the server")).toBe(true)
  for (const file of ['cli', 'electron', 'library', 'playwright', 'server', 'tui']) {
    expect(existsSync(join(baseDir!, 'examples', `${file}.md`))).toBe(true)
  }
  expect(readFileSync(join(baseDir!, 'examples/electron.md'), 'utf8')).toStartWith('# Example: Electron / desktop GUI app')
})

test('/run-skill-generator is user-only and ships the template with the examples', async () => {
  registerRunSkillGeneratorSkill()
  expect(skill('run-skill-generator').disableModelInvocation).toBe(true)
  const text = await promptText('run-skill-generator', '')
  const baseDir = /^Base directory for this skill: (.+)\n\n/.exec(text)?.[1]
  expect(text).toContain('Your job is to produce a **skill** at `<unit>/.claude/skills/run-<unit-name>/`')
  expect(text).not.toContain('## User Request')
  expect(readFileSync(join(baseDir!, 'template.md'), 'utf8')).toStartWith('---\nname: run-<unit-name>\n')
  expect(existsSync(join(baseDir!, 'examples/tui.md'))).toBe(true)
})

test('/fewer-permission-prompts matches the official 2.1.311 bundled skill', async () => {
  registerFewerPermissionPromptsSkill()
  expect(skill('fewer-permission-prompts').description).toBe(
    'Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project .claude/settings.json to reduce permission prompts.',
  )
  const plain = await promptText('fewer-permission-prompts', '')
  expect(plain).toStartWith('# Fewer Permission Prompts\n\nLook through my transcripts')
  expect(plain.endsWith('Do not touch any other settings field.\n')).toBe(true)
  const withArgs = await promptText('fewer-permission-prompts', 'skip git')
  expect(withArgs.endsWith('Do not touch any other settings field.\n\n\n## Additional instructions from the user\n\nskip git')).toBe(true)
})
