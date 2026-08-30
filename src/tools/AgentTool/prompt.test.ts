import { describe, expect, test } from 'bun:test'
import { getPrompt } from './prompt.js'
import type { AgentDefinition } from './loadAgentsDir.js'

const agent = {
  agentType: 'reviewer',
  whenToUse: 'Use for focused code review.',
  tools: ['Read', 'Grep'],
} as AgentDefinition

describe('AgentTool prompt', () => {
  test('defaults the dynamic agent list to conversation attachments', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    const previousListInMessages =
      process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    process.env.ANTHROPIC_API_KEY = 'test-key'
    delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES

    let prompt: string
    try {
      prompt = await getPrompt([agent])
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
      if (previousListInMessages === undefined)
        delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
      else
        process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = previousListInMessages
    }

    expect(prompt).toContain(
      'Available agent types are listed in <system-reminder> messages',
    )
    expect(prompt).not.toContain('reviewer: Use for focused code review.')
    expect(prompt).toContain('starts fresh')
    expect(prompt).toContain('Before creating an agent, self-check')
    expect(prompt).toContain('Do not create an agent that duplicates work')
    expect(prompt).toContain('Prefer resuming an existing agent')
    expect(prompt).toContain('what you expect it to return')
    expect(prompt).toContain('run_in_background')
    expect(prompt).toContain('do not poll')
    expect(prompt).toContain('single message with multiple Agent tool calls')
    expect(prompt).toContain('result is not visible to the user')
    expect(prompt).toContain('SendMessage')
    expect(prompt).toContain('research or edit')
    expect(prompt).toContain('isolation: "worktree"')
    expect(prompt).not.toContain('greeting-responder')
    expect(prompt).not.toContain('checks if a number is prime')
    expect(prompt.length).toBeLessThan(2_800)
  })

  test('supports explicitly restoring the inline agent list', async () => {
    const previous = process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    process.env.ANTHROPIC_API_KEY = 'test-key'

    try {
      const prompt = await getPrompt([agent])
      expect(prompt).toContain('reviewer: Use for focused code review.')
      expect(prompt).not.toContain(
        'Available agent types are listed in <system-reminder> messages',
      )
    } finally {
      if (previous === undefined)
        delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
      else process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = previous
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
    }
  })
})
