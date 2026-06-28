#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'

import { Box } from '../../ink.js'
import { renderToolResultMessage } from './UI.js'
import { formatToolResultMessage } from './formatToolResultMessage.js'
import { formatToolUseMessage } from './formatToolUseMessage.js'

describe('formatToolUseMessage', () => {
  it('shows action and session for read actions', () => {
    assert.equal(
      formatToolUseMessage({ action: 'read', sessionId: 'session-1' }),
      'action=read session=session-1',
    )
  })

  it('shows only the action for list actions', () => {
    assert.equal(formatToolUseMessage({ action: 'list' }), 'action=list')
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

  it('shows cwd and size for open actions', () => {
    assert.equal(
      formatToolUseMessage({
        action: 'open',
        cwd: '/tmp/project',
        cols: 120,
        rows: 30,
      }),
      'action=open cwd=/tmp/project cols=120 rows=30',
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
      'read session-1 (full)\nhello',
    )
  })

  it('renders compact read output as readable multiline text', () => {
    const message = formatToolResultMessage({
      sessionId: 'sess-1',
      mode: 'compact',
      text: 'alpha\nbeta',
      compressed: false,
      originalBytes: 10,
      returnedBytes: 10,
    })

    assert.equal(message, 'read sess-1 (compact)\nalpha\nbeta')
  })

  it('renders save_file with path and preview', () => {
    const message = formatToolResultMessage({
      sessionId: 'sess-1',
      mode: 'save_file',
      filePath: '/tmp/tool-results/read.txt',
      preview: 'alpha\nbeta',
      originalBytes: 10,
      previewBytes: 10,
    })

    assert.equal(
      message,
      'read sess-1 saved to /tmp/tool-results/read.txt\npreview:\nalpha\nbeta',
    )
  })
})

describe('renderToolResultMessage', () => {
  it('renders read output as a boxed preview view', () => {
    const rendered = renderToolResultMessage({
      sessionId: 'session-1',
      text: 'line1\nline2',
    })

    assert.ok(React.isValidElement(rendered))
    assert.equal(rendered.type, Box)
  })
})
