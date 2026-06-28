#!/usr/bin/env node
import assert from 'node:assert/strict'

import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerWorkflowSkill } from './workflow.js'
import { registerInteractiveTerminalSkill } from './interactiveTerminal.js'

clearBundledSkills()
registerWorkflowSkill()
registerInteractiveTerminalSkill()

const bundledSkills = getBundledSkills()

const workflowSkill = bundledSkills.find(skill => skill.name === 'workflow')
assert.ok(workflowSkill, 'workflow bundled skill should be registered')
assert.equal(workflowSkill.type, 'prompt')
assert.equal(workflowSkill.userInvocable, false)
assert.equal(workflowSkill.isHidden, true)
assert.equal(workflowSkill.disableModelInvocation, false)
assert.match(workflowSkill.description, /^Use when/)
assert.match(workflowSkill.whenToUse ?? '', /dynamic workflow/i)
assert.match(workflowSkill.whenToUse ?? '', /multi-agent/i)

const workflowPrompt = await workflowSkill.getPromptForCommand('', {} as never)
const workflowText = workflowPrompt
  .map(block => (block.type === 'text' ? block.text : ''))
  .join('\n')

assert.match(workflowText, /Workflow\(/)
assert.match(workflowText, /WorkflowTool/)
assert.match(workflowText, /scriptPath/)
assert.match(workflowText, /resumeFromRunId/)
assert.match(workflowText, /export const meta = \{ name, description, phases \}/)
assert.match(workflowText, /Do not manually perform phase work/i)
assert.doesNotMatch(workflowText, /run `?\/workflow/i)
assert.doesNotMatch(workflowText, /ask the user to run/i)

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
assert.match(terminalText, /Use Bash for one-shot commands/i)
assert.match(terminalText, /Close sessions when finished/i)
assert.match(terminalText, /Do not use InteractiveTerminal for file reads, edits, or searches/i)
assert.doesNotMatch(terminalText, /run `?\/interactive-terminal/i)
assert.doesNotMatch(terminalText, /ask the user to run/i)

console.log('modelInternalSkills.test.ts passed')
