import { expect, test } from 'bun:test'
import agents from './index.js'

test('/agents prints the removal notice like official 2.1.311', async () => {
  expect(agents.type).toBe('local')
  expect(agents.isHidden).toBe(true)
  expect(agents.supportsNonInteractive).toBe(true)
  const { call } = await agents.load()
  expect(await call('', {} as never)).toEqual({
    type: 'text',
    value: `The /agents wizard has been removed.
Ask Claude to create or update subagents for you (e.g. "create a code-reviewer subagent that ..."),
or edit the files directly:
  • .claude/agents/       (this project)
  • ~/.claude/agents/     (all projects)
Docs: https://code.claude.com/docs/en/sub-agents`,
  })
})
