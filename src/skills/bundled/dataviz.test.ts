import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerDatavizSkill } from './dataviz.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= {
  VERSION: 'test',
}

afterEach(() => clearBundledSkills())

test('/dataviz matches the official 2.1.303 bundled skill', async () => {
  registerDatavizSkill()
  const skill = getBundledSkills().find(command => command.name === 'dataviz')
  expect(skill?.type).toBe('prompt')
  if (skill?.type !== 'prompt') return
  expect(skill.userInvocable).toBe(true)
  expect(skill.description.startsWith('Use this skill whenever you are about to create ANY chart')).toBe(true)
  const [block] = await skill.getPromptForCommand('hello', {} as never)
  const text = (block as { type: 'text'; text: string }).text
  const baseDir = /^Base directory for this skill: (.+)\n\n/.exec(text)?.[1]
  expect(baseDir).toBeDefined()
  expect(text).toContain('\n\n# Data Visualization\n')
  // Same separators as official: the skill body, a blank line, then the request.
  expect(text.endsWith("Runnable six-checks validator (run it; don't eyeball) |\n\n\n## User Request\n\nhello")).toBe(true)
  for (const file of ['references/palette.md', 'references/anti-patterns.md', 'scripts/validate_palette.js', 'scripts/validate_palette.py']) {
    expect(existsSync(join(baseDir!, file))).toBe(true)
  }
})
