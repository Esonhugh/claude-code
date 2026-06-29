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
assert.match(workflowText, /explicit opt-in|explicitly opted into/i)
assert.match(workflowText, /Workflow\(\{ name/)
assert.match(workflowText, /Workflow\(\{ script/)
assert.match(workflowText, /Workflow\(\{ scriptPath/)
assert.match(workflowText, /scriptPath/)
assert.match(workflowText, /resumeFromRunId/)
assert.match(workflowText, /export const meta = \{ name, description, phases \}/)
assert.match(workflowText, /pure literal/i)
assert.match(workflowText, /computed keys/i)
assert.match(workflowText, /template interpolation/i)
assert.match(workflowText, /__proto__/)
assert.match(workflowText, /Date\.now|Math\.random/)
assert.match(workflowText, /dynamic import/i)
assert.match(workflowText, /pipeline\(\)/)
assert.match(workflowText, /parallel\(thunks\)/)
assert.match(workflowText, /not promises/i)
assert.match(workflowText, /failed branches|\bnull\b/i)
assert.match(workflowText, /hard cap/i)
assert.match(workflowText, /agent\(\{ schema \}\)/)
assert.match(workflowText, /adversarial/i)
assert.match(workflowText, /loop-until-dry/i)
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
