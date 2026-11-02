import { expect, test } from 'bun:test'
import { getPrompt as createPrompt } from './TaskCreateTool/prompt.js'
import { PROMPT as getPromptText } from './TaskGetTool/prompt.js'
import { getPrompt as listPrompt } from './TaskListTool/prompt.js'
import { PROMPT as updatePrompt } from './TaskUpdateTool/prompt.js'

test('short task tool prompts keep every rule with an example', () => {
  for (const rule of ['3 or more distinct steps', 'single, straightforward task', '`subject`', '`activeForm`', 'in_progress', 'TaskList first'])
    expect(createPrompt()).toContain(rule)
  for (const rule of ['TaskGet first', 'BEFORE starting', 'FULLY done', 'tests fail', '`deleted`', '`owner`', '`addBlockedBy`', '{"taskId": "2", "status": "in_progress"}'])
    expect(updatePrompt).toContain(rule)
  for (const rule of ['blockedBy', 'lowest ID first', 'TaskGet'])
    expect(listPrompt()).toContain(rule)
  expect(getPromptText).toContain('blockedBy is empty')
  const total = createPrompt().length + updatePrompt.length + listPrompt().length + getPromptText.length
  expect(total).toBeLessThan(2_800)
})

test('short TodoWrite prompt keeps every rule with an example', async () => {
  const { PROMPT } = await import('./TodoWriteTool/prompt.js')
  for (const rule of ['replaces the previous one', '3 or more distinct steps', 'single, straightforward task', '`content`', '`activeForm`', 'exactly ONE item in_progress', 'IMMEDIATELY', 'FULLY done', '"status": "in_progress"'])
    expect(PROMPT).toContain(rule)
  expect(PROMPT).not.toContain('When in doubt, use this tool')
  expect(PROMPT.length).toBeLessThan(1_600)
})
