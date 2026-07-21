import { describe, expect, test } from 'bun:test'
import { getPrompt } from './prompt.js'
import type { AgentDefinition } from './loadAgentsDir.js'

const agent = {
  agentType: 'reviewer',
  whenToUse: 'Use for focused code review.',
  tools: ['Read', 'Grep'],
} as AgentDefinition

describe('AgentTool prompt', () => {
  test('keeps orchestration rules without tutorial examples', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'

    let prompt: string
    try {
      prompt = await getPrompt([agent])
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
    }

    expect(prompt).toContain('reviewer: Use for focused code review.')
    expect(prompt).toContain('starts fresh')
    expect(prompt).toContain('what you expect it to return')
    expect(prompt).toContain('run_in_background')
    expect(prompt).toContain('do not poll')
    expect(prompt).toContain('single message with multiple Agent tool calls')
    expect(prompt).not.toContain('greeting-responder')
    expect(prompt).not.toContain('checks if a number is prime')
    expect(prompt.length).toBeLessThan(5_500)
  })
})
