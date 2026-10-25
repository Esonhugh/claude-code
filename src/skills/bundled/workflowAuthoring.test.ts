import assert from 'node:assert/strict'
import { afterEach, test } from 'bun:test'

import { resetSettingsCache, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'
import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import {
  WORKFLOW_AUTHORING_REFERENCE,
  WORKFLOW_AUTHORING_SKILL_NAME,
  registerWorkflowAuthoringSkill,
} from './workflowAuthoring.js'

afterEach(() => {
  clearBundledSkills()
  resetSettingsCache()
})

function workflowAuthoringSkill() {
  clearBundledSkills()
  registerWorkflowAuthoringSkill()
  const skill = getBundledSkills().find(command => command.name === WORKFLOW_AUTHORING_SKILL_NAME)
  assert.ok(skill && skill.type === 'prompt')
  return skill
}

test('/workflow-authoring is registered like the official 2.1.303 skill', async () => {
  const skill = workflowAuthoringSkill()
  assert.equal(skill.name, 'workflow-authoring')
  assert.equal(
    skill.description,
    'Reference for writing a Workflow tool script (script API and gotchas, resume, quality patterns, worked examples). Load before authoring a script for a workflow the user already opted into; it does not itself authorize running one.',
  )
  assert.equal(skill.userInvocable, true)
  assert.equal(skill.isHidden, false)
  const blocks = await skill.getPromptForCommand('ignored args', {} as never)
  assert.deepEqual(blocks, [{ type: 'text', text: WORKFLOW_AUTHORING_REFERENCE }])
})

test('the reference is the official text with the build-time placeholders resolved', () => {
  const text = WORKFLOW_AUTHORING_REFERENCE
  assert.ok(text.startsWith('# Workflow authoring reference\n\n'))
  assert.match(text, /^\*\*Ultracode\.\*\* When a system-reminder confirms ultracode is on/m)
  assert.match(text, /Pass the script inline via `script` — do not Write it to a file first\. Every invocation automatically persists its script/)
  assert.match(text, /isolation\?: 'worktree', agentType\?: string\}\): Promise<any>/)
  assert.match(text, /accepts at most 4096 items/)
  assert.match(text, /▸/)
  // The fork has no workflow subagent model override, so the official model guidance stays in.
  assert.match(text, /opts\.model overrides the model for this agent call\. Default to omitting it — the agent inherits the main-loop model/)
  assert.match(text, /model\?: string, effort\?: string/)
  assert.match(text, /Add `model` to a phase entry when that phase uses a specific model override\./)
  // Script examples keep their interpolations; no build-time placeholder or JS escape leaks through.
  assert.match(text, /log\(`\$\{bugs\.length\}\/10 found`\)/)
  assert.doesNotMatch(text, /\$\{(?:i|r|o|n|Cx|A2|kD|e\?)[^a-z]/)
  assert.doesNotMatch(text, /\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/)
  assert.match(text, /args: "\[\\"a\.ts\\", \.\.\.\]"/)
})

test('/workflow-authoring follows the workflow feature switch', () => {
  const skill = workflowAuthoringSkill()
  process.env.ANTHROPIC_API_KEY ??= 'test-only-not-a-real-key'
  setSessionSettingsCache({ settings: { enableWorkflows: true }, errors: [] })
  assert.equal(skill.isEnabled?.(), true)
  setSessionSettingsCache({ settings: { disableWorkflows: true }, errors: [] })
  assert.equal(skill.isEnabled?.(), false)
})
