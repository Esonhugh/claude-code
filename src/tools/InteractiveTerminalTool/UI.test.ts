#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatToolResultMessage } from './formatToolResultMessage.js'
import { formatToolUseMessage } from './formatToolUseMessage.js'

describe('formatToolUseMessage', () => {
  it('shows action and session for read actions', () => {
    assert.equal(
      formatToolUseMessage({ action: 'read', sessionId: 'session-1' }),
      'action=read session=session-1',
    )
  })

  it('shows key for send_key actions', () => {
    assert.equal(
      formatToolUseMessage({
        action: 'send_key',
        sessionId: 'session-2',
        key: 'CTRL_C',
      }),
      'action=send_key session=session-2 key=CTRL_C',
    )
  })

  it('shows command and cwd for open actions', () => {
    assert.equal(
      formatToolUseMessage({
        action: 'open',
        command: 'bash',
        cwd: '/tmp/project',
      }),
      'action=open command=bash cwd=/tmp/project',
    )
  })

  it('shows text and enter for write actions', () => {
    assert.equal(
      formatToolUseMessage({
        action: 'write',
        sessionId: 'session-1',
        text: 'echo hello',
        enter: true,
      }),
      'action=write session=session-1 text="echo hello" enter=true',
    )
  })
})

describe('formatToolResultMessage', () => {
  it('returns null for non-read successful results', () => {
    assert.equal(formatToolResultMessage({ sessionId: 'session-1' }), null)
  })

  it('keeps read result output visible', () => {
    assert.equal(
      formatToolResultMessage({ sessionId: 'session-1', text: 'hello' }),
      'read session-1 → hello',
    )
  })
})
