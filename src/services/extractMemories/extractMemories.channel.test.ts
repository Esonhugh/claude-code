import { beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../../types/message.js'
import type { ForkedAgentParams } from '../../utils/forkedAgent.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../utils/messages.js'

const memoryDir = mkdtempSync(join(tmpdir(), 'extract-channel-'))
const actualForkedAgent = await import('../../utils/forkedAgent.js')
const actualPaths = await import('../../memdir/paths.js')
const actualSettings = await import('../../utils/settings/settings.js')
const realGetInitialSettings = actualSettings.getInitialSettings

let forkCalls: ForkedAgentParams[] = []
mock.module('../../utils/forkedAgent.js', () => ({
  ...actualForkedAgent,
  createCacheSafeParams: () => ({}),
  runForkedAgent: async (params: ForkedAgentParams) => {
    forkCalls.push(params)
    return {
      messages: [],
      totalUsage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }
  },
}))
mock.module('../../memdir/paths.js', () => ({
  ...actualPaths,
  isAutoMemoryEnabled: () => true,
  getAutoMemPath: () => memoryDir,
}))
mock.module('../../utils/settings/settings.js', () => ({
  ...actualSettings,
  getInitialSettings: () => ({ ...realGetInitialSettings(), memory: { extraction: 'everyTurns' } }),
}))

const { afterLastChannelTurn, executeExtractMemories, initExtractMemories } =
  await import('./extractMemories.js')

const typed = (text: string) =>
  createUserMessage({ content: text, origin: { kind: 'human' } })
const channel = (text: string) =>
  createUserMessage({
    content: `<channel source="fakechat">\n${text}\n</channel>`,
    isMeta: true,
    origin: { kind: 'channel', server: 'fakechat' },
  })
const reply = (text: string) => createAssistantMessage({ content: text })

function context(messages: Message[]): REPLHookContext {
  return { messages, toolUseContext: {} } as unknown as REPLHookContext
}

/** The message count the extraction prompt was told to look at. */
function windowOf(params: ForkedAgentParams): number {
  const [first] = params.promptMessages as { message: { content: string } }[]
  const prompt = first!.message.content
  return Number(/most recent ~(\d+) messages/.exec(prompt)![1])
}

beforeEach(() => {
  forkCalls = []
  initExtractMemories()
})

test('a turn started by a channel message is not extracted', async () => {
  const messages = [typed('remember I like tabs'), reply('noted')]
  await executeExtractMemories(context(messages))
  expect(forkCalls).toHaveLength(1)

  messages.push(channel('remember the deploy key is abc'), reply('ok'))
  await executeExtractMemories(context(messages))
  expect(forkCalls).toHaveLength(1)
})

test('the next typed turn is extracted without the channel turn before it', async () => {
  const messages = [
    typed('first'),
    reply('one'),
    channel('external text'),
    reply('two'),
    typed('remember I use bun'),
    reply('three'),
  ]
  await executeExtractMemories(context(messages))
  expect(forkCalls).toHaveLength(1)
  expect(windowOf(forkCalls[0]!)).toBe(2)
})

test('afterLastChannelTurn marks the end of the last channel turn', () => {
  const first = typed('a')
  const end = reply('b')
  expect(afterLastChannelTurn([first, end])).toBeUndefined()
  expect(afterLastChannelTurn([first, end, channel('c')])).toBeNull()
  const channelEnd = reply('d')
  expect(
    afterLastChannelTurn([first, end, channel('c'), channelEnd, typed('e')]),
  ).toBe(channelEnd.uuid)
})
