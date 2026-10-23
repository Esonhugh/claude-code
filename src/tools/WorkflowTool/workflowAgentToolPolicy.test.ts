import assert from 'node:assert/strict'

import type { Tool, ToolUseContext } from '../../Tool.js'
import {
  applyWorkflowBashCommandClamp,
  clampWorkflowBashTool,
  normalizeWorkflowBashCommandClamp,
  normalizeWorkflowDisallowedTools,
  workflowPolicyDeniesTool,
  workflowPolicyDisallowedTools,
} from './workflowAgentToolPolicy.js'

assert.equal(normalizeWorkflowDisallowedTools(undefined), undefined)
assert.equal(normalizeWorkflowDisallowedTools([]), undefined)
assert.deepEqual(normalizeWorkflowDisallowedTools(['Write', 'Read', 'Write']), ['Read', 'Write'])
assert.throws(
  () => normalizeWorkflowDisallowedTools('Write'),
  /agent\(\) opts\.disallowedTools must be an array of non-empty tool-name strings .* got string\. Refusing the spawn/,
)
assert.throws(
  () => normalizeWorkflowDisallowedTools([' Write']),
  /got an array with non-string, empty, or whitespace-padded entries/,
)

assert.equal(normalizeWorkflowBashCommandClamp(undefined), undefined)
assert.deepEqual(
  normalizeWorkflowBashCommandClamp(['Bash(git status:*)', 'Bash(bun test:*)', 'Bash(git status:*)']),
  ['Bash(bun test:*)', 'Bash(git status:*)'],
)
assert.throws(
  () => normalizeWorkflowBashCommandClamp([42]),
  /agent\(\) opts\.bashCommandClamp must be an array of non-empty strings/,
)
assert.throws(
  () => normalizeWorkflowBashCommandClamp(['Read']),
  /entry 'Read' is not a Bash\(<command rule>\) rule: it names 'Read' instead of Bash/,
)
assert.throws(
  () => normalizeWorkflowBashCommandClamp(['Bash']),
  /entry 'Bash' is not a Bash\(<command rule>\) rule: it has no rule content/,
)
assert.throws(
  () => normalizeWorkflowBashCommandClamp(['Bash( git status)']),
  /it has whitespace-padded rule content/,
)

assert.equal(workflowPolicyDeniesTool({ disallowedTools: ['Bash(rm:*)', 'Write'] }, 'Bash'), true)
assert.equal(workflowPolicyDeniesTool({ disallowedTools: ['Write'] }, 'Bash'), false)
assert.deepEqual(workflowPolicyDisallowedTools({ disallowedTools: ['Write'] }), ['Write'])
assert.deepEqual(
  workflowPolicyDisallowedTools({ disallowedTools: ['Write'], bashCommandClamp: ['Bash(git status:*)'] }),
  ['Write', 'mcp__*', 'ToolSearch'],
)

const seen: unknown[] = []
const bashTool = {
  name: 'Bash',
  async checkPermissions(input: unknown) {
    seen.push(input)
    return { behavior: 'allow', updatedInput: input }
  },
} as unknown as Tool
const otherTool = { name: 'Read' } as unknown as Tool
const context = {} as ToolUseContext

const clamped = clampWorkflowBashTool(bashTool, ['Bash(git status:*)', 'Bash(bun test)'])
assert.equal(clamped.name, 'Bash')
assert.equal((await clamped.checkPermissions({ command: 'git status --short' } as never, context)).behavior, 'allow')
assert.equal((await clamped.checkPermissions({ command: 'bun test' } as never, context)).behavior, 'allow')
assert.deepEqual(seen, [{ command: 'git status --short' }, { command: 'bun test' }])

const denied = await clamped.checkPermissions({ command: 'git push origin main' } as never, context)
assert.equal(denied.behavior, 'deny')
assert.match(
  (denied as { message: string }).message,
  /Permission to use Bash with command git push origin main has been denied: this workflow agent is clamped to Bash\(git status:\*\), Bash\(bun test\)/,
)
assert.deepEqual(
  (denied as { decisionReason: unknown }).decisionReason,
  { type: 'other', reason: 'workflow agent() bashCommandClamp' },
)
// Compound commands must match the clamp in every segment.
assert.equal((await clamped.checkPermissions({ command: 'git status && rm -rf x' } as never, context)).behavior, 'deny')
assert.equal((await clamped.checkPermissions({} as never, context)).behavior, 'deny')
assert.equal(seen.length, 2)

assert.deepEqual(applyWorkflowBashCommandClamp([bashTool, otherTool], undefined), [bashTool, otherTool])
assert.deepEqual(applyWorkflowBashCommandClamp([bashTool, otherTool], { disallowedTools: ['Write'] }), [bashTool, otherTool])
const applied = applyWorkflowBashCommandClamp([bashTool, otherTool], { bashCommandClamp: ['Bash(git status:*)'] })
assert.notEqual(applied[0], bashTool)
assert.equal(applied[0]!.name, 'Bash')
assert.equal(applied[1], otherTool)

console.log('workflowAgentToolPolicy.test.ts passed')
