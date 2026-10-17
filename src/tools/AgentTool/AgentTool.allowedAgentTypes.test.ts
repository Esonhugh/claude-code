import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getDefaultAppState } from '../../state/AppStateStore.js'
import { createStore } from '../../state/store.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

process.env.ANTHROPIC_API_KEY ??= 'test-only-not-a-real-key'
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-allowed-types-')))
process.env.CLAUDE_CONFIG_DIR = configDir

let capturedAllowedAgentTypes: string[] | undefined | null = null
mock.module('./runAgent.js', () => ({
  async *runAgent(params: { allowedAgentTypes?: string[] }) {
    capturedAllowedAgentTypes = params.allowedAgentTypes
    yield {
      type: 'assistant',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        id: 'msg_allowed_types',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: 'standard',
          cache_creation: null,
        },
      },
    }
  },
}))
const { AgentTool } = await import('./AgentTool.js')

const nestedSpawner = {
  ...GENERAL_PURPOSE_AGENT,
  agentType: 'nested-spawner',
  source: 'projectSettings' as const,
  tools: ['Agent(Explore)', 'Read'],
  getSystemPrompt: () => 'nested spawner',
}

function setup() {
  const state = getDefaultAppState()
  const store = createStore({
    ...state,
    toolPermissionContext: getEmptyToolPermissionContext(),
    mcp: { ...state.mcp, clients: [], tools: [] },
  })
  const context = {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: {
        activeAgents: [GENERAL_PURPOSE_AGENT, nestedSpawner],
        inactiveAgents: [],
        allowedAgentTypes: undefined,
      },
    },
    messages: [],
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: store.getState,
    setAppState: store.setState,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
  return context
}

const allowed = async () => ({ behavior: 'allow' as const })

const cases: Array<[string, string[] | undefined]> = [
  ['nested-spawner', ['Explore']],
  ['general-purpose', undefined],
]
for (const [subagentType, expected] of cases) {
  test(`C6 ${subagentType} passes its resolved allowedAgentTypes to runAgent`, async () => {
    capturedAllowedAgentTypes = null
    const result = await AgentTool.call(
      {
        prompt: 'spawn something',
        description: 'allowed types probe',
        subagent_type: subagentType,
        run_in_background: false,
      },
      setup(),
      allowed,
      { message: { id: 'msg_parent' } } as never,
    )
    expect(result.data.status).toBe('completed')
    expect(capturedAllowedAgentTypes).toEqual(expected)
  })
}

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})
