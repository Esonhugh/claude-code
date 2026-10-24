#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  terminalPreviewHeight,
  terminalPreviewLines,
  terminalPreviewSummary,
  terminalPreviewVisibleRows,
} from './terminalPreview.js'

describe('terminalPreview', () => {
  it('limits detail preview by PTY rows and dialog visibility', () => {
    const lines = terminalPreviewLines(
      'line1\nline2\nline3\nline4\nline5',
      4,
      3,
    )

    assert.deepEqual(lines, ['line3', 'line4', 'line5'])
  })

  it('preserves all 6 visible rows when PTY rows is 6', () => {
    const lines = terminalPreviewLines(
      'line7\nline8\nline9\nline10\nline11\nbash-5.3$',
      6,
      6,
    )

    assert.deepEqual(lines, ['line7', 'line8', 'line9', 'line10', 'line11', 'bash-5.3$'])
  })

  it('uses the last non-empty visible line for list summary', () => {
    const summary = terminalPreviewSummary(
      'Claude\n\nTool call finished\n',
    )

    assert.equal(summary, 'Tool call finished')
  })

  it('adds border allowance when computing preview box height', () => {
    assert.equal(terminalPreviewHeight(6), 8)
    assert.equal(terminalPreviewHeight(1), 3)
    assert.equal(terminalPreviewHeight(40), 42)
  })

  it('fits detail preview rows into the space the dialog actually gets', () => {
    // fullscreen bottom area is half the terminal; dialog chrome takes 14 rows
    assert.equal(terminalPreviewVisibleRows(24, 36, true), 4)
    assert.equal(terminalPreviewVisibleRows(24, 80, true), 24)
    assert.equal(terminalPreviewVisibleRows(30, 36, false), 22)
    assert.equal(terminalPreviewVisibleRows(24, 10, true), 3)
  })

  it('drops blank rows below the cursor before picking visible rows', () => {
    const lines = terminalPreviewLines(
      'line1\nline2\n>>> \n\n   \n\u001b[0m\n',
      24,
      2,
    )

    assert.deepEqual(lines, ['line2', '>>> '])
  })
})
