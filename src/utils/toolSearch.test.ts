import { describe, expect, test } from 'bun:test'
import type { Tool } from '../Tool.js'
import type { Message } from '../types/message.js'
import { getDeferredToolsDelta } from './toolSearch.js'

const names = [
  'mcp__browser__click',
  'mcp__browser__evaluate',
  'mcp__browser__navigate',
  'mcp__browser__screenshot',
]

const tools = names.map(
  name => ({ name, shouldDefer: true }) as unknown as Tool,
)

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
