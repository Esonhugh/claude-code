import { afterEach, beforeEach, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { QuerySource } from './constants/querySource.js'
import { buildTool, type ToolUseContext } from './Tool.js'
import type { Message } from './types/message.js'
import { query } from './query.js'
import { runPostCompactCleanup } from './services/compact/postCompactCleanup.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { createAssistantMessage, extractTextContent } from './utils/messages.js'
import { getDefaultAppState, type AppState } from './state/AppStateStore.js'
import { resetStateForTests } from './bootstrap/state.js'
import { resetAdvisorRefusalsForTesting, resolveAdvisorModelId } from './utils/advisor.js'
import { type AdvisorRequest, getMainAdvisorCarrier } from './utils/advisorQuery.js'

const SWITCH = 'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL'
// Set where requests cannot carry the server-side advisor.
const NO_BETAS = 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'
const otherProviders = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]
const saved = Object.fromEntries(
  [SWITCH, NO_BETAS, ...otherProviders].map(key => [key, process.env[key]]),
)

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

type RunOptions = {
  mainLoopModel?: string
  advisorPin?: AdvisorRequest
  /** Messages already in the conversation, after the user's request. */
  earlier?: Message[]
  /** The model calls `advisor` as an ordinary tool although the request did not offer it. */
  callsUnoffered?: boolean
  /** The API refuses the first request's server-side advisor; the model then calls another tool. */
  refusesFirst?: boolean
}

function createToolUseContext(
  advisorModel: string | undefined,
  { mainLoopModel = 'claude-sonnet-4-6', advisorPin }: RunOptions,
): ToolUseContext {
  let appState: AppState = { ...getDefaultAppState(), advisorModel }
  return {
    advisorPin,
    options: {
      commands: [], debug: false, mainLoopModel,
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

// What each request offered and declared, and what the loop told the conversation.
async function run(advisorModel: string | undefined, options: RunOptions = {}) {
  const offered: string[][] = []
  const serverAdvisors: (string | undefined)[] = []
  const announcements: unknown[] = []
  const retryTools: (string[] | undefined)[] = []
  const iterator = query({
    messages: [{
      type: 'user', uuid: '00000000-0000-4000-8000-000000000001', timestamp: '2026-11-18T00:00:00.000Z',
      message: { role: 'user', content: 'pick an approach' },
    } as Message, ...(options.earlier ?? [])],
    systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    toolUseContext: createToolUseContext(advisorModel, options),
    querySource: 'repl_main_thread' as QuerySource,
    deps: {
      uuid: () => crypto.randomUUID(),
      microcompact: async messages => ({ messages }),
      autocompact: async messages => ({ messages, wasCompacted: false }),
      callModel: async function* ({ tools, options: requestOptions }) {
        offered.push(tools.map(t => t.name))
        serverAdvisors.push(requestOptions.advisorModel)
        retryTools.push(requestOptions.advisorRetryTools?.map(t => t.name))
        if (offered.length === 1 && options.refusesFirst) {
          requestOptions.onAdvisorRefused?.()
          yield createAssistantMessage({
            content: [{ type: 'tool_use', id: 'toolu_other', name: 'Other', input: {} }],
          })
          return
        }
        if (offered.length === 1 && (offered[0]!.includes('advisor') || options.callsUnoffered)) {
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
    const next = await iterator.next()
    if (next.done) return { offered, serverAdvisors, announcements, retryTools }
    const message = next.value as Message
    if (message.type === 'attachment' && message.attachment.type === 'advisor_tool') {
      announcements.push(message.attachment)
    }
  }
}

beforeEach(() => {
  resetStateForTests()
  resetAdvisorRefusalsForTesting()
  seenByTool = undefined
  process.env[SWITCH] = '1'
  delete process.env[NO_BETAS]
  for (const key of otherProviders) delete process.env[key]
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('any main model and advisor declare the server-side advisor first and leave the local tool out', async () => {
  const { offered, serverAdvisors, announcements } = await run('Opus 5.5', { mainLoopModel: 'Grok-4.7' })
  expect(offered).toEqual([['Other']])
  expect(serverAdvisors).toEqual(['Opus 5.5'])
  expect(announcements).toMatchObject([{ available: true }])
  expect(seenByTool).toBeUndefined()
})

test('a request that declares the server-side advisor hands its retry the local tool', async () => {
  expect((await run('Opus 5.5')).retryTools).toEqual([['Other', 'advisor']])
  // Nothing to hand over: no server-side advisor, or a fork.
  process.env[NO_BETAS] = '1'
  expect((await run('Opus 5.5')).retryTools).toEqual([undefined, undefined])
  delete process.env[NO_BETAS]
  const pin = { advisorModel: resolveAdvisorModelId('opus'), advisorDeferred: false, advisorActive: true }
  expect((await run('opus', { advisorPin: pin })).retryTools).toEqual([undefined])
})

test('where requests cannot carry the server-side advisor the local tool is offered and sees the reply that called it', async () => {
  process.env[NO_BETAS] = '1'
  const { offered, serverAdvisors } = await run('Opus 5.5')
  expect(offered).toEqual([['Other', 'advisor'], ['Other', 'advisor']])
  expect(serverAdvisors).toEqual([undefined, undefined])
  expect(seenByTool).toEqual({ replyInHistory: false, response: ['Should I use A or B?', ''] })
})

test('without an advisor model the request leaves the local advisor tool out', async () => {
  expect((await run(undefined)).offered).toEqual([['Other']])
  expect(seenByTool).toBeUndefined()
})

test('without the switch the tool list goes out untouched and no advisor is declared', async () => {
  delete process.env[SWITCH]
  const { offered, serverAdvisors, announcements } = await run('opus')
  expect(offered).toEqual([['Other', 'advisor'], ['Other', 'advisor']])
  expect(serverAdvisors).toEqual([undefined, undefined])
  expect(announcements).toEqual([])
})

test('a gateway that hands the server-side advisor call back as an ordinary tool call gets the local answer', async () => {
  const { offered, serverAdvisors } = await run('opus', { callsUnoffered: true })
  expect(offered).toEqual([['Other'], ['Other']])
  expect(serverAdvisors).toEqual([resolveAdvisorModelId('opus'), resolveAdvisorModelId('opus')])
  expect(seenByTool?.response).toEqual(['Should I use A or B?', ''])
})

// The refused request had announced the server-side advisor.
const announced = (): Message[] => [{
  type: 'attachment', uuid: '00000000-0000-4000-8000-000000000002', timestamp: '2026-11-18T00:00:01.000Z',
  attachment: { type: 'advisor_tool', available: true, model: resolveAdvisorModelId('opus') },
} as unknown as Message]

test('after the API refused the advisor the local tool takes over and the conversation is not told the advisor went away', async () => {
  getMainAdvisorCarrier().held = { model: undefined, refused: true }
  const { offered, serverAdvisors, announcements } = await run('opus', { earlier: announced() })
  expect(offered).toEqual([['Other', 'advisor'], ['Other', 'advisor']])
  expect(serverAdvisors).toEqual([undefined, undefined])
  expect(announcements).toEqual([])
})

test('a refusal reported by the request hands the conversation to the local tool from the next request', async () => {
  const { offered, serverAdvisors, announcements } = await run('opus', { refusesFirst: true })
  expect(offered).toEqual([['Other'], ['Other', 'advisor']])
  expect(serverAdvisors).toEqual([resolveAdvisorModelId('opus'), undefined])
  expect(announcements).toMatchObject([{ available: true }])
})

test('subagent compaction leaves the main conversation on the local advisor after a refusal', async () => {
  await run('opus', { refusesFirst: true })
  expect(getMainAdvisorCarrier().held?.refused).toBe(true)
  runPostCompactCleanup('agent:general-purpose')

  const { offered, serverAdvisors } = await run('opus', { earlier: announced() })
  expect(serverAdvisors).toEqual([undefined, undefined])
  expect(offered).toEqual([['Other', 'advisor'], ['Other', 'advisor']])
})

test('main compaction resets the conversation refusal and retries the server-side advisor', async () => {
  await run('opus', { refusesFirst: true })
  expect(getMainAdvisorCarrier().held?.refused).toBe(true)
  runPostCompactCleanup('repl_main_thread')

  const { offered, serverAdvisors } = await run('opus')
  expect(serverAdvisors).toEqual([resolveAdvisorModelId('opus')])
  expect(offered).toEqual([['Other']])
})

test('with the switch off a conversation that had the advisor is told it went away', async () => {
  delete process.env[SWITCH]
  getMainAdvisorCarrier().held = { model: undefined, refused: true }
  const { announcements } = await run('opus', { earlier: announced() })
  expect(announcements).toEqual([{ type: 'advisor_tool', available: false }])
})

test('a fork offers what its parent request offered', async () => {
  const pin = { advisorModel: undefined, advisorDeferred: false, advisorActive: false }
  expect((await run('Opus 5.5', { advisorPin: { ...pin, localAdvisorModel: 'Opus 5.5' } })).offered[0])
    .toEqual(['Other', 'advisor'])
  // The parent's request declared the server-side advisor, so it had no local tool.
  expect((await run('opus', { advisorPin: { ...pin, advisorModel: resolveAdvisorModelId('opus'), advisorActive: true } })).offered)
    .toEqual([['Other']])
})
