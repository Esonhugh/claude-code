import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const querySource = readFileSync('src/query.ts', 'utf8')
const attachmentSource = readFileSync('src/utils/attachments.ts', 'utf8')

assert.match(
  querySource,
  /getAttachmentMessages\(\s*null,\s*updatedToolUseContext,/,
  'workflow subagent follow-up turns must collect attachments with updated tool context after tool execution',
)

assert.match(
  querySource,
  /querySource\.startsWith\('agent:'\)/,
  'agent query sources must continue through the same query loop that collects follow-up attachments',
)

assert.match(
  attachmentSource,
  /maybe\('skill_listing', \(\) => getSkillListingAttachments\(context\)\)/,
  'skill listing must remain in all-thread attachments so workflow agents can see model-invocable skills before choosing tools',
)

assert.doesNotMatch(
  attachmentSource,
  /isMainThread[\s\S]{0,120}maybe\('skill_listing'/,
  'skill listing must not be gated to the main thread; workflow subagents need the same Skill tool discovery context as official Claude Code',
)

console.log('workflowSkillActivity.test.ts passed')
