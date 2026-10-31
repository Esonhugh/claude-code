import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRegisteredHooks, setCwdState } from '../../bootstrap/state.js'
import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerClaudeApiSkill } from './claudeApi.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= {
  VERSION: 'test',
}

const originalCwd = process.cwd()
afterEach(() => {
  clearBundledSkills()
  setCwdState(originalCwd)
})

function claudeApi() {
  const command = getBundledSkills().find(c => c.name === 'claude-api')
  if (command?.type !== 'prompt') throw new Error('missing claude-api')
  return command
}

test('/claude-api uses the official 2.1.311 content and model ids', async () => {
  const project = mkdtempSync(join(tmpdir(), 'claude-api-skill-'))
  writeFileSync(join(project, 'package.json'), '{}')
  setCwdState(project)
  registerClaudeApiSkill()
  const skill = claudeApi()
  expect(skill.description).toStartWith('Reference for the Claude API / Anthropic SDK — model ids, pricing,')
  expect(skill.allowedTools).toEqual(['WebFetch(domain:platform.claude.com)'])
  const [block] = await skill.getPromptForCommand('add streaming', {} as never)
  const text = (block as { type: 'text'; text: string }).text
  const baseDir = /^Base directory for this skill: (.+)\n\n/.exec(text)?.[1]
  expect(text).toContain('# Building LLM-Powered Applications with Claude')
  expect(text).toContain('`claude-opus-5-5`')
  expect(text).not.toContain('{{OPUS_ID}}')
  expect(text).toContain('## Detected Language: typescript\n\n`typescript/claude-api/README.md` is included below')
  expect(text).toContain('<doc path="typescript/claude-api/README.md">')
  expect(text.endsWith('## User Request\n\nadd streaming')).toBe(true)
  for (const file of ['shared/models.md', 'shared/managed-agents-quickstarts/bug-hunter.md', 'shared/evals/report/runner-scaffold.mjs', 'python/claude-api/README.md']) {
    expect(existsSync(join(baseDir!, file))).toBe(true)
  }
  // The ant-command guard can run here, so managed-agents-secure ships like official.
  expect(existsSync(join(baseDir!, 'shared/managed-agents-secure.md'))).toBe(true)
  expect(text).not.toContain('## Security Comparison Unavailable')
  expect(getRegisteredHooks()?.PreToolUse?.[0]?.matcher).toBe('Bash|PowerShell|Monitor')
})

test('/claude-api can be turned off like official', () => {
  process.env.CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL = '1'
  try {
    registerClaudeApiSkill()
    expect(claudeApi().isEnabled?.()).toBe(false)
  } finally {
    delete process.env.CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL
  }
})
