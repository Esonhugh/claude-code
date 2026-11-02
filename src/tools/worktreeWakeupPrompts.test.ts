import { expect, test } from 'bun:test'
import { getEnterWorktreeToolPrompt } from './EnterWorktreeTool/prompt.js'
import { getExitWorktreeToolPrompt } from './ExitWorktreeTool/prompt.js'
import { SCHEDULE_WAKEUP_PROMPT } from './ScheduleWakeupTool/prompt.js'

test('short worktree and wakeup prompts keep every rule', () => {
  const enter = getEnterWorktreeToolPrompt()
  for (const rule of ['ONLY when the user explicitly mentions a worktree', '`worktree.baseRef`', '`git worktree list`', 'WorktreeCreate/WorktreeRemove hooks', 'ExitWorktree will not remove'])
    expect(enter).toContain(rule)
  const exit = getExitWorktreeToolPrompt()
  for (const rule of ['never proactively', '`"keep"`', '`"remove"`', 'confirm with the user before retrying with `discard_changes: true`'])
    expect(exit).toContain(rule)
  for (const rule of ['`stop: true`', '`noop: true`', 'do not poll it', '1200-1800s', 'Never wake just to keep the prompt cache warm'])
    expect(SCHEDULE_WAKEUP_PROMPT).toContain(rule)
  expect(enter.length + exit.length + SCHEDULE_WAKEUP_PROMPT.length).toBeLessThan(3_600)
})
