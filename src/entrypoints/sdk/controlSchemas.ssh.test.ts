import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
import {
  SDKControlRequestSchema,
  SSHHistoryChunkSchema,
  StdinMessageSchema,
} from './controlSchemas.js'

describe('SSH shell control schema', () => {
  it('requires a nonempty session capability', () => {
    const valid = SDKControlRequestSchema().safeParse({
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'run_shell_command',
        command: 'pwd',
        ssh_remote_token: 'session-token',
      },
    })
    const empty = SDKControlRequestSchema().safeParse({
      type: 'control_request',
      request_id: 'req-2',
      request: {
        subtype: 'run_shell_command',
        command: 'pwd',
        ssh_remote_token: '',
      },
    })
    const missing = SDKControlRequestSchema().safeParse({
      type: 'control_request',
      request_id: 'req-3',
      request: {
        subtype: 'run_shell_command',
        command: 'pwd',
      },
    })

    assert.equal(valid.success, true)
    assert.equal(empty.success, false)
    assert.equal(missing.success, false)
  })

  it('validates managed SSH history replay and cancellation', () => {
    const replay = SDKControlRequestSchema().safeParse({
      type: 'control_request',
      request_id: 'history-1',
      request: {
        subtype: 'replay_history',
        ssh_remote_token: 'session-token',
      },
    })
    const missingCapability = SDKControlRequestSchema().safeParse({
      type: 'control_request',
      request_id: 'history-2',
      request: { subtype: 'replay_history' },
    })
    const cancellation = StdinMessageSchema().safeParse({
      type: 'control_cancel_request',
      request_id: 'history-1',
    })

    assert.equal(replay.success, true)
    assert.equal(missingCapability.success, false)
    assert.equal(cancellation.success, true)
  })

  it('validates bounded SSH file suggestion requests', () => {
    const valid = SDKControlRequestSchema().safeParse({
      type: 'control_request',
      request_id: 'suggest-1',
      request: {
        subtype: 'ssh_file_suggestions',
        version: 1,
        query: 'src/pri',
        mode: 'path',
        limit: 10,
        ssh_remote_token: 'session-token',
      },
    })
    const invalidRequests = [
      { query: 'x', mode: 'fuzzy', limit: 1, ssh_remote_token: '' },
      { query: 'x\0y', mode: 'fuzzy', limit: 1, ssh_remote_token: 'token' },
      { query: 'x'.repeat(4097), mode: 'fuzzy', limit: 1, ssh_remote_token: 'token' },
      { query: 'x', mode: 'fuzzy', limit: 0, ssh_remote_token: 'token' },
      { query: 'x', mode: 'fuzzy', limit: 51, ssh_remote_token: 'token' },
      { query: 'x', mode: 'other', limit: 1, ssh_remote_token: 'token' },
    ]

    assert.equal(valid.success, true)
    for (const [index, request] of invalidRequests.entries()) {
      assert.equal(
        SDKControlRequestSchema().safeParse({
          type: 'control_request',
          request_id: `invalid-${index}`,
          request: {
            subtype: 'ssh_file_suggestions',
            version: 1,
            ...request,
          },
        }).success,
        false,
      )
    }
  })

  it('validates bounded history chunks', () => {
    const assistantTimestamp = '2026-08-20T00:00:00.000Z'
    const valid = SSHHistoryChunkSchema().safeParse({
      type: 'ssh_history_chunk',
      request_id: 'history-1',
      sequence: 0,
      messages: [
        {
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          parent_tool_use_id: null,
          uuid: 'message-1',
          session_id: 'session-1',
          timestamp: assistantTimestamp,
        },
      ],
    })
    const invalid = SSHHistoryChunkSchema().safeParse({
      type: 'ssh_history_chunk',
      request_id: 'history-1',
      sequence: -1,
      messages: [],
    })

    assert.equal(valid.success, true)
    assert.equal(
      valid.success
        ? (valid.data.messages[0] as { timestamp?: string }).timestamp
        : undefined,
      assistantTimestamp,
    )
    assert.equal(invalid.success, false)
  })
})
