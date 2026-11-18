import { afterEach, beforeEach, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { QuerySource } from './constants/querySource.js'
import { buildTool, type ToolUseContext } from './Tool.js'
import type { Message } from './types/message.js'
import { query } from './query.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { createAssistantMessage, extractTextContent } from './utils/messages.js'
import { getDefaultAppState, type AppState } from './state/AppStateStore.js'
import { resetStateForTests } from './bootstrap/state.js'

const SWITCH = 'CLAUDE_CODE_ENABLE_LOCAL_ADVISOR_TOOL'
const savedSwitch = process.env[SWITCH]

// What a tool named `advisor` can see of the response that called it.
let seenByTool: { replyInHistory: boolean; response: string[] } | undefined

const tool = (name: string) => buildTool({
  name, inputSchema: z.strictObject({}),
  maxResultSizeChars: Infinity, isConcurrencySafe: () => true,
  description: async () => name, prompt: async () => name, renderToolUseMessage: () => null,
  call: async (_input: unknown, context: ToolUseContext) => {
    seenByTool = {
      replyInHistory: JSON.stringify(context.messages).includes('Should I use A or B?'),
      response: (context.getResponseMessages?.() ?? []).map(m =>
        extractTextContent(m.message.content as { type: string }[]),
      ),
    }
    return { data: 'ok' }
  },
  mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', tool_use_id: id, content: String(data) }),
})

const TOOLS = [tool('Other'), tool('advisor')]

function createToolUseContext(advisorModel: string | undefined): ToolUseContext {
  let appState: AppState = { ...getDefaultAppState(), advisorModel }
  return {
    options: {
      commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6',
      tools: TOOLS,
      verbose: false, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => appState,
    setAppState: updater => { appState = updater(appState) },
    setInProgressToolUseIDs: () => {}, setResponseLength: () => {},
    updateFileHistoryState: () => {}, updateAttributionState: () => {},
    messages: [],
  }
}

async function run(advisorModel: string | undefined) {
  const offered: string[][] = []
  const iterator = query({
    messages: [{
      type: 'user', uuid: '00000000-0000-4000-8000-000000000001', timestamp: '2026-11-18T00:00:00.000Z',
      message: { role: 'user', content: 'pick an approach' },
    } as Message],
    systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    toolUseContext: createToolUseContext(advisorModel),
    querySource: 'repl_main_thread' as QuerySource,
    deps: {
      uuid: () => crypto.randomUUID(),
      microcompact: async messages => ({ messages }),
      autocompact: async messages => ({ messages, wasCompacted: false }),
      callModel: async function* ({ tools }) {
        offered.push(tools.map(t => t.name))
        if (offered.length === 1 && offered[0]!.includes('advisor')) {
          // The stream delivers each content block as its own message.
          yield createAssistantMessage({ content: 'Should I use A or B?' })
          yield createAssistantMessage({
            content: [{ type: 'tool_use', id: 'toolu_advisor', name: 'advisor', input: {} }],
          })
          return
        }
        yield createAssistantMessage({ content: 'done' })
      },
    },
  })
  while (true) {
    if ((await iterator.next()).done) return offered
  }
}

beforeEach(() => {
  resetStateForTests()
  seenByTool = undefined
  delete process.env[SWITCH]
})

afterEach(() => {
  if (savedSwitch === undefined) delete process.env[SWITCH]
  else process.env[SWITCH] = savedSwitch
})

test('the local advisor tool is offered while an advisor model is set and sees the reply that called it', async () => {
  process.env[SWITCH] = '1'
  const offered = await run('Opus 5.5')
  expect(offered).toEqual([['Other', 'advisor'], ['Other', 'advisor']])
  expect(seenByTool).toEqual({ replyInHistory: false, response: ['Should I use A or B?', ''] })
})

test('without an advisor model the request leaves the local advisor tool out', async () => {
  process.env[SWITCH] = '1'
  expect(await run(undefined)).toEqual([['Other']])
  expect(seenByTool).toBeUndefined()
})

test('with the switch off the tool list goes out untouched', async () => {
  expect(await run(undefined)).toEqual([['Other', 'advisor'], ['Other', 'advisor']])
})
