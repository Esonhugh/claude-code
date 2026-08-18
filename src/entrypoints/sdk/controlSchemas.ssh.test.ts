import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
import { SDKControlRequestSchema } from './controlSchemas.js'

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
})
