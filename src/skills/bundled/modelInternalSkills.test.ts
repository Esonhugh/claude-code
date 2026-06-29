#!/usr/bin/env node
import assert from 'node:assert/strict'

import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerInteractiveTerminalSkill } from './interactiveTerminal.js'

clearBundledSkills()
registerInteractiveTerminalSkill()

const bundledSkills = getBundledSkills()
assert.equal(
  bundledSkills.some(skill => skill.name === 'workflow'),
  false,
  'workflow guidance should live on WorkflowTool prompt, not a bundled skill',
)

const terminalSkill = bundledSkills.find(skill => skill.name === 'interactive-terminal')
assert.ok(terminalSkill, 'interactive-terminal bundled skill should be registered')
assert.equal(terminalSkill.type, 'prompt')
assert.equal(terminalSkill.userInvocable, false)
assert.equal(terminalSkill.isHidden, true)
assert.equal(terminalSkill.disableModelInvocation, false)
assert.match(terminalSkill.description, /^Use when/)
assert.match(terminalSkill.whenToUse ?? '', /persistent/i)
assert.match(terminalSkill.whenToUse ?? '', /REPL/i)

const terminalPrompt = await terminalSkill.getPromptForCommand('', {} as never)
const terminalText = terminalPrompt
  .map(block => (block.type === 'text' ? block.text : ''))
  .join('\n')

for (const action of ['open', 'list', 'write', 'read', 'send_key', 'resize', 'signal', 'status', 'close']) {
  assert.match(terminalText, new RegExp(`\\b${action}\\b`), `terminal prompt should mention ${action}`)
}
assert.match(terminalText, /persistent terminal sessions/i)
assert.match(terminalText, /Use Bash for one-shot commands/i)
assert.match(terminalText, /read before/i)
assert.match(terminalText, /sessionId/)
assert.match(terminalText, /special keys/i)
assert.match(terminalText, /Close sessions when finished/i)
assert.match(terminalText, /Bash can block|Bash is not suitable for multi-step interaction/i)
assert.match(terminalText, /Do not use InteractiveTerminal for file reads, edits, or searches/i)
assert.doesNotMatch(terminalText, /run `?\/interactive-terminal/i)
assert.doesNotMatch(terminalText, /ask the user to run/i)

console.log('modelInternalSkills.test.ts passed')
