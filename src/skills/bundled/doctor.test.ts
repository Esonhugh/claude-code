import { afterAll, beforeAll, expect, test } from 'bun:test'
import { clearBundledSkills, getBundledSkills, registerBundledSkill } from '../bundledSkills.js'
import { registerDoctorSkill } from './doctor.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= {
  VERSION: 'test',
  PACKAGE_URL: '@esonhugh/claude-code',
}

const claudeApiArgs: string[] = []

beforeAll(() => {
  clearBundledSkills()
  registerBundledSkill({
    name: 'claude-api',
    description: 'stub',
    async getPromptForCommand(args) {
      claudeApiArgs.push(args)
      return [{ type: 'text', text: 'claude-api prompt' }]
    },
  })
  registerDoctorSkill()
})

afterAll(() => clearBundledSkills())

function doctor() {
  const skill = getBundledSkills().find(command => command.name === 'doctor')
  if (skill?.type !== 'prompt') throw new Error('doctor skill missing')
  return skill
}

test('/doctor is the 2.1.311 checkup skill, not a model-invocable one', () => {
  const skill = doctor()
  expect(skill.aliases).toEqual(['checkup'])
  expect(skill.disableModelInvocation).toBe(true)
  expect(skill.argumentHint).toBe('[prompt-audit [<path>]]')
  expect(skill.progressMessage).toBe('running checkup')
})

test('/doctor builds the checkup prompt and appends user instructions', async () => {
  const [plain] = await doctor().getPromptForCommand('', {} as never)
  const text = (plain as { text: string }).text
  expect(text).toStartWith('# Claude Code Doctor\n\nHealth-check my Claude Code setup')
  expect(text).toContain('## Check 9 — pre-approve frequently denied read-only commands')
  expect(text).not.toContain('Check 10')
  expect(text).not.toContain('@anthropic-ai/claude-code')
  expect(text).not.toContain('## Additional instructions from the user')

  const [withArgs] = await doctor().getPromptForCommand('focus on hooks', {} as never)
  expect((withArgs as { text: string }).text).toEndWith(
    '\n\n## Additional instructions from the user\n\nfocus on hooks',
  )
})

test('/doctor prompt-audit hands off to the claude-api prompt audit', async () => {
  const [audit] = await doctor().getPromptForCommand('prompt-audit', {} as never)
  expect((audit as { text: string }).text).toBe('claude-api prompt')
  await doctor().getPromptForCommand('prompt-audit src/CLAUDE.md', {} as never)
  expect(claudeApiArgs[0]).toStartWith(
    'prompt-audit\n\nRun the `prompt-audit` subcommand from the Subcommands table above',
  )
  expect(claudeApiArgs[1]).toBe('prompt-audit src/CLAUDE.md')
})
