import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import {
  BoundedMessageUuidSet,
  convertSDKHistory,
} from './sdkMessageAdapter.js'

const sessionId = '11111111-1111-4111-8111-111111111111'

describe('convertSDKHistory', () => {
  test('projects replayable transcript messages in stable order', () => {
    const history = [
      {
        type: 'user',
        message: { role: 'user', content: 'first prompt' },
        parent_tool_use_id: null,
        uuid: '22222222-2222-4222-8222-222222222222',
        session_id: sessionId,
        isReplay: true,
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
        },
        parent_tool_use_id: null,
        uuid: '33333333-3333-4333-8333-333333333333',
        session_id: sessionId,
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'done',
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: '44444444-4444-4444-8444-444444444444',
        session_id: sessionId,
        isReplay: true,
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 123 },
        uuid: '55555555-5555-4555-8555-555555555555',
        session_id: sessionId,
      },
    ] satisfies SDKMessage[]

    const converted = convertSDKHistory(history)

    expect(converted.map(message => String(message.uuid))).toEqual(
      history.map(message => message.uuid),
    )
    expect(converted.map(message => message.type)).toEqual([
      'user',
      'assistant',
      'user',
      'system',
    ])
    expect(converted[0]?.type === 'user' && converted[0].message.content).toBe(
      'first prompt',
    )
    expect(
      converted[2]?.type === 'user' &&
        Array.isArray(converted[2].message.content) &&
        converted[2].message.content[0]?.type,
    ).toBe('tool_result')
    expect(
      converted[3]?.type === 'system' && converted[3].subtype,
    ).toBe('compact_boundary')
  })

  test('omits transport noise and duplicate UUIDs', () => {
    const duplicateUuid = '66666666-6666-4666-8666-666666666666'
    const history = [
      {
        type: 'user',
        message: { role: 'user', content: 'once' },
        parent_tool_use_id: null,
        uuid: duplicateUuid,
        session_id: sessionId,
        isReplay: true,
      },
      {
        type: 'user',
        message: { role: 'user', content: 'duplicate' },
        parent_tool_use_id: null,
        uuid: duplicateUuid,
        session_id: sessionId,
        isReplay: true,
      },
      {
        type: 'system',
        subtype: 'status',
        status: 'compacting',
        uuid: '77777777-7777-4777-8777-777777777777',
        session_id: sessionId,
      },
      {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'ok',
        stop_reason: null,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        uuid: '88888888-8888-4888-8888-888888888888',
        session_id: sessionId,
      },
    ] satisfies SDKMessage[]

    const converted = convertSDKHistory(history)

    expect(converted).toHaveLength(1)
    expect(converted[0]?.uuid).toBe(duplicateUuid)
  })
})

describe('BoundedMessageUuidSet', () => {
  test('deduplicates live echoes and evicts the oldest UUID', () => {
    const seen = new BoundedMessageUuidSet(2)

    expect(seen.remember('first')).toBe(true)
    expect(seen.remember('first')).toBe(false)
    expect(seen.remember('second')).toBe(true)
    expect(seen.remember('third')).toBe(true)
    expect(seen.remember('first')).toBe(true)
  })
})
