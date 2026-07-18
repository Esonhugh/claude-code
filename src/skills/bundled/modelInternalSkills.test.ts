#!/usr/bin/env node
import assert from 'node:assert/strict'

import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerTerminalSkill } from './terminal.js'

clearBundledSkills()
registerTerminalSkill()

const bundledSkills = getBundledSkills()
assert.equal(
  bundledSkills.some(skill => skill.name === 'workflow'),
  false,
  'workflow guidance should live on WorkflowTool prompt, not a bundled skill',
)

const terminalSkill = bundledSkills.find(skill => skill.name === 'terminal')
assert.ok(terminalSkill, 'terminal bundled skill should be registered')
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

for (const action of ['new-session', 'list-panes', 'send-keys', 'capture-pane', 'resize-pane', 'send-signal', 'display-message', 'kill-pane']) {
  assert.match(terminalText, new RegExp(`\\b${action}\\b`), `terminal prompt should mention ${action}`)
}
assert.match(terminalText, /persistent terminal sessions/i)
assert.match(terminalText, /Use Bash for one-shot commands/i)
assert.match(terminalText, /capture-pane before/i)
assert.match(terminalText, /target/)
assert.match(terminalText, /special keys/i)
assert.match(terminalText, /command as one executable and args as its argv array/i)
assert.match(terminalText, /resolved through PATH/i)
assert.match(terminalText, /\.\/built-claude/)
assert.match(terminalText, /default SHELL/i)
assert.match(terminalText, /Close sessions with kill-pane when finished/i)
assert.match(terminalText, /Bash can block|Bash is not suitable for multi-step interaction/i)
assert.match(terminalText, /Do not use Terminal for file reads, edits, or searches/i)
for (const oldTerm of [
  'Interactive' + 'Terminal',
  'interactive-' + 'terminal',
  'session' + 'Id',
  'send' + '_key',
]) {
  assert.doesNotMatch(terminalText, new RegExp(oldTerm))
}
assert.doesNotMatch(terminalText, /\bopen\b|\bread\b|\bwrite\b/)
assert.doesNotMatch(terminalText, /run `?\/terminal/i)
assert.doesNotMatch(terminalText, /ask the user to run/i)

console.log('modelInternalSkills.test.ts passed')
