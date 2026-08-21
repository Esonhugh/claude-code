import { describe, expect, test } from 'bun:test'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { ToolUseContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { getAgentListingDeltaAttachment } from './attachments.js'

const reviewer = {
  agentType: 'reviewer',
  whenToUse: 'Use for focused code review.',
  tools: ['Read', 'Grep'],
} as AgentDefinition

function context(): ToolUseContext {
  const appState = getDefaultAppState()
  return {
    options: {
      tools: [{ name: 'Agent' }],
      agentDefinitions: {
        activeAgents: [reviewer],
        allowedAgentTypes: undefined,
      },
    },
    getAppState: () => appState,
  } as unknown as ToolUseContext
}

describe('agent listing attachments', () => {
  test('announces the list once and preserves exact agent metadata', () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    const previousListInMessages =
      process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    process.env.ANTHROPIC_API_KEY = 'test-key'
    delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES

    try {
      const first = getAgentListingDeltaAttachment(context(), [])
      expect(first).toHaveLength(1)
      expect(first[0]).toMatchObject({
        type: 'agent_listing_delta',
        addedTypes: ['reviewer'],
        addedLines: [
          '- reviewer: Use for focused code review. (Tools: Read, Grep)',
        ],
        removedTypes: [],
        isInitial: true,
      })

      const messages = [
        {
          type: 'attachment',
          attachment: first[0],
        },
      ] as Message[]
      expect(getAgentListingDeltaAttachment(context(), messages)).toEqual([])
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
      if (previousListInMessages === undefined)
        delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
      else
        process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = previousListInMessages
    }
  })
})
