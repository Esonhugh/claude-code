import { describe, expect, spyOn, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import * as auth from './auth.js'
import type { Tool } from '../Tool.js'
import type { Message } from '../types/message.js'
import {
  getDeferredToolsDelta,
  getToolSearchRefusal,
  isToolSearchEnabled,
} from './toolSearch.js'
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

test('tool search refusal classification follows 2.1.311', () => {
  const error = (status: number, message: string, type = 'invalid_request_error') =>
    APIError.generate(status, { type: 'error', error: { type, message } }, message, new Headers())
  const previous = process.env.ANTHROPIC_BASE_URL
  try {
    delete process.env.ANTHROPIC_BASE_URL
    expect(getToolSearchRefusal(error(400, 'Unexpected value(s) `advanced-tool-use-2025-11-20` for the `anthropic-beta` header'))).toBe('beta')
    expect(getToolSearchRefusal(error(400, 'tools.2.defer_loading: Extra inputs are not permitted'))).toBe('unattributed')
    expect(getToolSearchRefusal(error(422, 'tools.2.defer_loading: unknown field'))).toBe('unattributed')
    // The direct API only blames tool search when the error says so.
    expect(getToolSearchRefusal(error(400, 'messages.0: bad content'))).toBeNull()
    expect(getToolSearchRefusal(error(500, 'defer_loading'))).toBeNull()
    expect(getToolSearchRefusal(error(400, 'defer_loading', 'billing_error'))).toBeNull()

    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example'
    expect(getToolSearchRefusal(error(400, 'messages.0: bad content'))).toBe('unattributed')
    expect(getToolSearchRefusal(error(400, 'prompt is too long: 210000 tokens > 200000 maximum'))).toBeNull()
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = previous
  }
})
