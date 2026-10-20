import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { autoCompactIfNeeded } from './autoCompact.js'
import {
  requestClassifierOverflowCompaction,
  takeClassifierOverflowCompaction,
} from './classifierOverflow.js'
import * as compact from './compact.js'
import * as memory from './sessionMemoryCompact.js'
import * as cleanup from './postCompactCleanup.js'
import * as mode from './compactMode.js'
import * as config from '../../utils/config.js'
import * as tokens from '../../utils/tokens.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'

const restores: (() => void)[] = []
const savedDisableCompact = process.env.DISABLE_COMPACT

beforeEach(() => {
  delete process.env.DISABLE_COMPACT
  for (const stub of [
    spyOn(mode, 'getCompactMode').mockReturnValue('claude'),
    spyOn(config, 'getGlobalConfig').mockReturnValue({ autoCompactEnabled: true } as never),
    // Far below the autocompact threshold: only the classifier request can trigger it.
    spyOn(tokens, 'tokenCountWithEstimation').mockReturnValue(1000),
    spyOn(cleanup, 'runPostCompactCleanup').mockImplementation(() => {}),
    spyOn(memory, 'trySessionMemoryCompaction').mockResolvedValue(null),
    spyOn(compact, 'compactConversation').mockImplementation(async () => ({
      boundaryMarker: createCompactBoundaryMessage('auto', 1000),
      summaryMessages: [],
      messagesToKeep: [createUserMessage({ content: 'summary', isCompactSummary: true, isMeta: true })],
      attachments: [],
      hookResults: [],
      preCompactTokenCount: 1000,
      postCompactTokenCount: 20,
    })),
  ]) restores.push(() => stub.mockRestore())
})

afterEach(() => {
  for (const restore of restores.splice(0)) restore()
  takeClassifierOverflowCompaction(undefined)
  if (savedDisableCompact === undefined) delete process.env.DISABLE_COMPACT
  else process.env.DISABLE_COMPACT = savedDisableCompact
})

function context(): ToolUseContext {
  let state = getDefaultAppState()
  return {
    getAppState: () => state,
    setAppState: (update: (prev: typeof state) => typeof state) => { state = update(state) },
    readFileState: createFileStateCacheWithSizeLimit(10),
    setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
    messages: [createUserMessage({ content: 'original' }), createAssistantMessage({ content: 'old answer' })],
    options: { mainLoopModel: 'claude-sonnet-4-6', verbose: true, tools: [], commands: [], debug: false,
      ideInstallationStatus: null, theme: 'dark',
      thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined } },
    abortController: new AbortController(),
    setMessages() {}, onChangeAPIKey() {},
  } as unknown as ToolUseContext
}

const params = (ctx: ToolUseContext) =>
  ({ toolUseContext: ctx, systemPrompt: [], userContext: {}, systemContext: {}, forkContextMessages: ctx.messages }) as never

test('a classifier overflow forces compaction below the threshold and tells the model what did not run', async () => {
  const ctx = context()
  expect(requestClassifierOverflowCompaction(undefined, ctx.messages, 'Bash')).toBe(true)
  expect(requestClassifierOverflowCompaction(undefined, ctx.messages, 'Write')).toBe(true)
  const result = await autoCompactIfNeeded(ctx.messages, ctx, params(ctx), 'repl_main_thread')
  expect(result.wasCompacted).toBe(true)
  expect(JSON.stringify(result.compactionResult?.attachments)).toContain(
    'Auto mode could not review 2 earlier tool calls (Bash, Write) because the conversation was too long for its classifier',
  )
  // Without a request the same transcript stays below the threshold.
  expect((await autoCompactIfNeeded(ctx.messages, ctx, params(ctx), 'repl_main_thread')).wasCompacted).toBe(false)
})

test('an overflow on a transcript head that was already compacted falls back instead of requesting again', () => {
  const ctx = context()
  expect(requestClassifierOverflowCompaction(undefined, ctx.messages, 'Bash')).toBe(true)
  expect(takeClassifierOverflowCompaction(undefined)?.deniedToolNames).toEqual(['Bash'])
  expect(requestClassifierOverflowCompaction(undefined, ctx.messages, 'Bash')).toBe(false)
  const subagent = 'agent-1'
  expect(requestClassifierOverflowCompaction(subagent, ctx.messages, 'Bash')).toBe(true)
  takeClassifierOverflowCompaction(subagent)
})

test('DISABLE_COMPACT keeps the old fallback', () => {
  process.env.DISABLE_COMPACT = '1'
  expect(requestClassifierOverflowCompaction(undefined, context().messages, 'Bash')).toBe(false)
})
