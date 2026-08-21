import assert from 'node:assert/strict'
import { describe, it, mock } from 'bun:test'
import type { SDKControlRequest, StdoutMessage } from '../entrypoints/sdk/controlTypes.js'
import type { Message } from '../types/message.js'
import { ManagedSSHControlService } from './remoteSSHControl.js'
import type { ToolPermissionContext } from '../Tool.js'

mock.module('./managedSSHPermissions.js', () => {
  const overlay = { permissions: {} as Record<string, string[]> }
  return {
    applySSHPermissionOverlayUpdate(update: { type: string; behavior?: string; rules?: Array<{ toolName: string; ruleContent?: string }> }) {
      if (update.type === 'addRules' && update.behavior) {
        overlay.permissions[update.behavior] = [
          ...(overlay.permissions[update.behavior] ?? []),
          ...(update.rules ?? []).map(rule =>
            rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName,
          ),
        ]
      }
      return overlay
    },
    readSSHPermissionRuntimeState(context: ToolPermissionContext) {
      return {
        overlay,
        rules: [],
        additionalDirectories: Array.from(
          context.additionalWorkingDirectories as unknown as ReadonlyMap<string, unknown>,
        ).map(([, directory]) => directory),
      }
    },
  }
})

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

  it('reads and updates SSH permission overlay through capability-gated control requests', () => {
    const output: StdoutMessage[] = []
    let context: ToolPermissionContext = {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    }
    const service = new ManagedSSHControlService({
      environment,
      getHistory: () => [],
      getSessionId: () => sessionId,
      enqueue: message => output.push(message),
      getToolPermissionContext: () => context,
      setAppState: updater => {
        const next = updater({ toolPermissionContext: context } as never)
        context = next.toolPermissionContext
      },
    })

    const handled = service.handleRequest(
      request('permissions-1', {
        subtype: 'ssh_update_permissions',
        ssh_remote_token: 'session-token',
        update: {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Read', ruleContent: '//tmp/**' }],
        },
      }),
    )

    assert.equal(handled, true)
    assert.deepEqual(context.alwaysAllowRules.sshOverlay, ['Read(//tmp/**)'])
    const response = output.at(-1)
    assert.equal(response?.type, 'control_response')
    assert.equal(
      response?.type === 'control_response' && response.response.subtype,
      'success',
    )
  })

  it('rejects SSH permission overlay requests without a valid capability', () => {
    const output: StdoutMessage[] = []
    const setAppState = mock(() => {})
    const service = new ManagedSSHControlService({
      environment,
      getHistory: () => [],
      getSessionId: () => sessionId,
      enqueue: message => output.push(message),
      getToolPermissionContext: () => ({
        mode: 'default',
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
      }),
      setAppState,
    })

    service.handleRequest(
      request('permissions-2', {
        subtype: 'ssh_update_permissions',
        ssh_remote_token: 'wrong-token',
        update: {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Read' }],
        },
      }),
    )

    assert.equal(setAppState.mock.calls.length, 0)
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
