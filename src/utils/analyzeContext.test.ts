import { describe, expect, test } from 'bun:test'
import type { Anthropic } from '@anthropic-ai/sdk'
import type { Message } from '../types/message.js'
import {
  estimateToolSchemaTokenAllocation,
  getLoadedDeferredToolNames,
} from './analyzeContext.js'

const schema = (
  name: string,
  description: string,
  propertyDescription: string,
): Anthropic.Beta.Messages.BetaToolUnion => ({
  name,
  description,
  input_schema: {
    type: 'object',
    properties: {
      value: { type: 'string', description: propertyDescription },
    },
  },
})

describe('estimateToolSchemaTokenAllocation', () => {
  test('weights production name, description, and JSON schema', () => {
    const details = estimateToolSchemaTokenAllocation(
      [
        schema('small', 'short', 'short'),
        schema(
          'large',
          'A substantially longer production tool description '.repeat(20),
          'A substantially longer JSON schema description '.repeat(20),
        ),
      ],
      1_000,
    )

    expect(details.find(tool => tool.name === 'large')!.tokens).toBeGreaterThan(
      details.find(tool => tool.name === 'small')!.tokens,
    )
  })

  test('does not reallocate excluded Skill tokens to other tools', () => {
    const details = estimateToolSchemaTokenAllocation(
      [
        schema('Read', 'read files', 'path'),
        schema('Skill', 'Skill frontmatter '.repeat(100), 'skill name'),
      ],
      1_000,
      new Set(['Skill']),
    )

    expect(details.map(tool => tool.name)).toEqual(['Read'])
    expect(details[0]!.tokens).toBeLessThan(500)
  })
})

describe('getLoadedDeferredToolNames', () => {
  const deferredTools = [{ name: 'DeferredA' }, { name: 'DeferredB' }] as never

  test('uses tool_reference discovery rather than later tool calls', () => {
    const messages = [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'search',
              content: [
                { type: 'tool_reference', tool_name: 'DeferredA' },
                { type: 'tool_reference', tool_name: 'Unrelated' },
              ],
            },
          ],
        },
      },
    ] as Message[]

    expect([...getLoadedDeferredToolNames(deferredTools, messages)]).toEqual([
      'DeferredA',
    ])
  })

  test('preserves tool_reference discovery across compact boundaries', () => {
    const messages = [
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: '00000000-0000-0000-0000-000000000000',
        timestamp: new Date().toISOString(),
        compactMetadata: { preCompactDiscoveredTools: ['DeferredB'] },
      },
    ] as Message[]

    expect([...getLoadedDeferredToolNames(deferredTools, messages)]).toEqual([
      'DeferredB',
    ])
  })
})
