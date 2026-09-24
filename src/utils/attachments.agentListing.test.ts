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
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',
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
    abortController: new AbortController(),
  } as unknown as ToolUseContext
}

describe('agent listing attachments', () => {
  test('announces the list once and preserves exact agent metadata', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    const previousListInMessages =
      process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    process.env.ANTHROPIC_API_KEY = 'test-key'
    delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES

    try {
      const first = await getAgentListingDeltaAttachment(context(), [])
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
      expect(await getAgentListingDeltaAttachment(context(), messages)).toEqual([])
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
      if (previousListInMessages === undefined)
        delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
      else
        process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = previousListInMessages
    }
  })

  test('captures and releases an agent.offer snapshot before query starts', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    const previousListInMessages =
      process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    process.env.ANTHROPIC_API_KEY = 'test-key'
    delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    const toolUseContext = context()
    let captures = 0
    let releases = 0
    toolUseContext.mods = {
      hasHooks: event => event === 'agent.offer',
      capture: () => {
        captures++
        return {
          hasHooks: event => event === 'agent.offer',
          dispatch: async () => ({ isOffered: false }),
          release: () => {
            releases++
          },
        }
      },
    } as unknown as ToolUseContext['mods']

    try {
      expect(
        await getAgentListingDeltaAttachment(toolUseContext, []),
      ).toEqual([])
      expect(captures).toBe(1)
      expect(releases).toBe(1)
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
      if (previousListInMessages === undefined)
        delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
      else
        process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = previousListInMessages
    }
  })

  test('projects the attachment listing through agent.offer', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    const previousListInMessages =
      process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    process.env.ANTHROPIC_API_KEY = 'test-key'
    delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    const toolUseContext = context()
    const inputs: unknown[] = []
    toolUseContext.modsSnapshot = {
      hasHooks: event => event === 'agent.offer',
      dispatch: async (_event, input) => {
        inputs.push(input)
        return { isOffered: false }
      },
      release() {},
    }

    try {
      expect(
        await getAgentListingDeltaAttachment(toolUseContext, []),
      ).toEqual([])
      expect(inputs).toEqual([
        {
          agent: 'reviewer',
          description: 'Use for focused code review.',
          source: reviewer.source,
          provider: { plugin: 'engine', tier: 'core' },
        },
      ])
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
