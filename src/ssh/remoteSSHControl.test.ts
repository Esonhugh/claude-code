import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
import type { SDKControlRequest, StdoutMessage } from '../entrypoints/sdk/controlTypes.js'
import type { Message } from '../types/message.js'
import { ManagedSSHControlService } from './remoteSSHControl.js'

const environment = {
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
  CLAUDE_CODE_SSH_REMOTE: '1',
  CLAUDE_CODE_SSH_REMOTE_TOKEN: 'session-token',
}
const sessionId = '11111111-1111-4111-8111-111111111111'

function request(
  requestId: string,
  inner: SDKControlRequest['request'],
): SDKControlRequest {
  return { type: 'control_request', request_id: requestId, request: inner }
}

describe('managed SSH print control service', () => {
  it('emits bounded replay chunks before its completion response', () => {
    const output: StdoutMessage[] = []
    const history = [
      {
        type: 'user',
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        timestamp: '2026-08-20T00:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      },
    ] as Message[]
    const service = new ManagedSSHControlService({
      environment,
      getHistory: () => history,
      getSessionId: () => sessionId,
      enqueue: message => output.push(message),
    })

    assert.equal(
      service.handleRequest(
        request('history-1', {
          subtype: 'replay_history',
          ssh_remote_token: 'session-token',
        }),
      ),
      true,
    )

    assert.equal(output[0]?.type, 'ssh_history_chunk')
    assert.deepEqual(output[1], {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'history-1',
        response: {
          session_id: sessionId,
          count: 1,
          last_uuid: history[0]?.uuid,
        },
      },
    })
  })

  it('rejects replay before emitting history when capability is invalid', () => {
    const output: StdoutMessage[] = []
    const service = new ManagedSSHControlService({
      environment,
      getHistory: () => {
        throw new Error('history must not be read')
      },
      getSessionId: () => sessionId,
      enqueue: message => output.push(message),
    })

    service.handleRequest(
      request('history-1', {
        subtype: 'replay_history',
        ssh_remote_token: 'wrong-token',
      }),
    )

    assert.equal(output.length, 1)
    assert.equal(output[0]?.type, 'control_response')
    assert.equal(
      output[0]?.type === 'control_response' && output[0].response.subtype,
      'error',
    )
  })

  it('cancels one file request without emitting its late response', async () => {
    const output: StdoutMessage[] = []
    let observedAbort = false
    const service = new ManagedSSHControlService({
      environment,
      getHistory: () => [],
      getSessionId: () => sessionId,
      enqueue: message => output.push(message),
      queryFileSuggestions: (_request, dependencies) =>
        new Promise(resolve => {
          dependencies.signal?.addEventListener(
            'abort',
            () => {
              observedAbort = true
              resolve({ items: [], incomplete: false })
            },
            { once: true },
          )
        }),
    })

    service.handleRequest(
      request('suggest-1', {
        subtype: 'ssh_file_suggestions',
        version: 1,
        query: 'src',
        mode: 'fuzzy',
        limit: 10,
        ssh_remote_token: 'session-token',
      }),
    )
    assert.equal(service.cancel('suggest-1'), true)
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(observedAbort, true)
    assert.deepEqual(output, [])
  })
})
