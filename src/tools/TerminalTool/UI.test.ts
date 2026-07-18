#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'

import { Box } from '../../ink.js'
import { renderToolResultMessage } from './UI.js'
import { formatToolResultMessage } from './formatToolResultMessage.js'
import { formatToolUseMessage } from './formatToolUseMessage.js'

describe('formatToolUseMessage', () => {
  it('shows action and target for capture-pane actions', () => {
    assert.equal(
      formatToolUseMessage({ action: 'capture-pane', target: 'term-1' }),
      'action=capture-pane target=term-1',
    )
  })

  it('shows only the action for list-panes actions', () => {
    assert.equal(formatToolUseMessage({ action: 'list-panes' }), 'action=list-panes')
  })

  it('shows key for send-keys actions', () => {
    assert.equal(
      formatToolUseMessage({
        action: 'send-keys',
        target: 'term-2',
        key: 'CTRL_C',
      }),
      'action=send-keys target=term-2 key=CTRL_C',
    )
  })

  it('shows cwd and size for new-session actions', () => {
    assert.equal(
      formatToolUseMessage({
        action: 'new-session',
        cwd: '/tmp/project',
        cols: 120,
        rows: 30,
      }),
      'action=new-session command=<default-shell> cwd=/tmp/project cols=120 rows=30',
    )
  })

  it('shows command and args for new-session without env values', () => {
    assert.equal(
      formatToolUseMessage({
        action: 'new-session',
        command: 'python',
        args: ['-i', '-q'],
        cwd: '/tmp/project',
      }),
      'action=new-session command=python args=["-i","-q"] cwd=/tmp/project',
    )
  })

  it('shows text and enter for send-keys actions', () => {
    assert.equal(
      formatToolUseMessage({
        action: 'send-keys',
        target: 'term-1',
        text: 'echo hello',
        enter: true,
      }),
      'action=send-keys target=term-1 text="echo hello" enter=true',
    )
  })
})

describe('formatToolResultMessage', () => {
  it('returns null for non-capture successful results', () => {
    assert.equal(formatToolResultMessage({ target: 'term-1' }), null)
  })

  it('keeps capture-pane result output visible', () => {
    assert.equal(
      formatToolResultMessage({ target: 'term-1', text: 'hello' }),
      'capture-pane term-1 (full)\nhello',
    )
  })

  it('renders compact capture-pane output as readable multiline text', () => {
    const message = formatToolResultMessage({
      target: 'term-1',
      mode: 'compact',
      text: 'alpha\nbeta',
      compressed: false,
      originalBytes: 10,
      returnedBytes: 10,
    })

    assert.equal(message, 'capture-pane term-1 (compact)\nalpha\nbeta')
  })

  it('renders save_file with path and preview', () => {
    const message = formatToolResultMessage({
      target: 'term-1',
      mode: 'save_file',
      filePath: '/tmp/tool-results/capture-pane.txt',
      preview: 'alpha\nbeta',
      originalBytes: 10,
      previewBytes: 10,
    })

    assert.equal(
      message,
      'capture-pane term-1 saved to /tmp/tool-results/capture-pane.txt\npreview:\nalpha\nbeta',
    )
  })
})

describe('renderToolResultMessage', () => {
  it('renders capture-pane output as a boxed preview view', () => {
    const rendered = renderToolResultMessage({
      target: 'term-1',
      text: 'line1\nline2',
    })

    assert.ok(React.isValidElement(rendered))
    assert.equal(rendered.type, Box)
  })
})
