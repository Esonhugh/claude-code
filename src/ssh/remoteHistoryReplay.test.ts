import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
import type { Message } from '../types/message.js'
import {
  buildSSHHistoryReplay,
  projectSSHHistoryMessages,
} from './remoteHistoryReplay.js'

const sessionId = '11111111-1111-4111-8111-111111111111'

describe('remote SSH history replay', () => {
  it('projects only supported transcript messages and preserves identity', () => {
    const messages = [
      {
        type: 'user',
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        timestamp: '2026-08-20T00:00:00.000Z',
        message: { role: 'user', content: 'hello' },
        isMeta: true,
      },
      {
        type: 'system',
        subtype: 'informational',
        uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        timestamp: '2026-08-20T00:00:01.000Z',
        content: 'UI only',
      },
      {
        type: 'assistant',
        uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        timestamp: '2026-08-20T00:00:02.000Z',
        message: {
          id: 'msg-1',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'world' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ] as Message[]

    const projected = projectSSHHistoryMessages(messages, sessionId)

    assert.equal(projected.length, 2)
    assert.equal(projected[0]?.type, 'user')
    assert.equal((projected[0] as { isReplay?: boolean }).isReplay, true)
    assert.equal((projected[0] as { isSynthetic?: boolean }).isSynthetic, true)
    assert.equal(projected[0]?.uuid, messages[0]?.uuid)
    assert.equal(projected[0]?.session_id, sessionId)
    assert.equal(
      (projected[1] as { timestamp?: string }).timestamp,
      messages[2]?.timestamp,
    )
  })

  it('chunks replay output and reports a bounded completion summary', () => {
    const messages = Array.from({ length: 3 }, (_, index) => ({
      type: 'user' as const,
      uuid: `00000000-0000-4000-8000-00000000000${index}`,
      timestamp: `2026-08-20T00:00:0${index}.000Z`,
      message: { role: 'user' as const, content: `message-${index}` },
    })) as Message[]

    const replay = buildSSHHistoryReplay(messages, {
      requestId: 'history-1',
      sessionId,
      maxMessagesPerChunk: 2,
      maxChunkBytes: 4096,
    })

    assert.deepEqual(
      replay.chunks.map(chunk => ({
        sequence: chunk.sequence,
        count: chunk.messages.length,
      })),
      [
        { sequence: 0, count: 2 },
        { sequence: 1, count: 1 },
      ],
    )
    assert.deepEqual(replay.response, {
      session_id: sessionId,
      count: 3,
      last_uuid: messages[2]?.uuid,
    })
  })

  it('rejects a single history message that exceeds the chunk byte bound', () => {
    const messages = [
      {
        type: 'user',
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        timestamp: '2026-08-20T00:00:00.000Z',
        message: { role: 'user', content: 'x'.repeat(1024) },
      },
    ] as Message[]

    assert.throws(
      () =>
        buildSSHHistoryReplay(messages, {
          requestId: 'history-1',
          sessionId,
          maxChunkBytes: 128,
        }),
      /exceeds chunk byte limit/,
    )
  })
})
