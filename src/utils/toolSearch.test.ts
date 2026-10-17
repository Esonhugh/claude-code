import { describe, expect, spyOn, test } from 'bun:test'
import * as auth from './auth.js'
import type { Tool } from '../Tool.js'
import type { Message } from '../types/message.js'
import { getDeferredToolsDelta, isToolSearchEnabled } from './toolSearch.js'
import { getEmptyToolPermissionContext } from '../Tool.js'

const names = [
  'mcp__browser__click',
  'mcp__browser__evaluate',
  'mcp__browser__navigate',
  'mcp__browser__screenshot',
]

const tools = names.map(
  name => ({ name, shouldDefer: true }) as unknown as Tool,
)


test('auto tool-search excludes tools pinned inline by Mods before counting schemas', async () => {
  const subscriber = spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(false)
  const previous = process.env.ENABLE_TOOL_SEARCH
  process.env.ENABLE_TOOL_SEARCH = 'auto:10'
  const pinned = { name: 'mcp__corp__pinned', isMcp: true } as Tool
  const search = { name: 'ToolSearch' } as Tool
  const descriptions = new Map([
    [pinned, { description: 'pinned', isDeferred: false }],
  ])
  try {
    expect(
      await isToolSearchEnabled(
        'claude-sonnet-5',
        [pinned, search],
        async () => getEmptyToolPermissionContext(),
        [],
        'test',
        descriptions,
      ),
    ).toBe(false)
    expect(
      getDeferredToolsDelta([pinned, search], [], undefined, descriptions),
    ).toBeNull()
  } finally {
    subscriber.mockRestore()
    if (previous === undefined) delete process.env.ENABLE_TOOL_SEARCH
    else process.env.ENABLE_TOOL_SEARCH = previous
  }
})

describe('getDeferredToolsDelta', () => {
  test('compresses display lines but retains exact names for delta state', () => {
    const delta = getDeferredToolsDelta(tools, [])

    expect(delta).toEqual({
      addedNames: names,
      addedLines: [
        'mcp__browser__* (4 tools; use ToolSearch by capability)',
      ],
      removedNames: [],
    })

    const messages = [
      {
        type: 'attachment',
        attachment: { type: 'deferred_tools_delta', ...delta },
      },
    ] as Message[]
    expect(getDeferredToolsDelta(tools, messages)).toBeNull()
  })
})
