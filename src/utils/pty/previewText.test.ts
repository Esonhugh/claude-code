#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeTerminalPreview } from './previewText.ts'

describe('normalizeTerminalPreview', () => {
  it('preserves CRLF terminal output lines', () => {
    assert.equal(
      normalizeTerminalPreview('echo preview\r\npreview\r\n'),
      'echo preview\npreview',
    )
  })

  it('keeps only the latest redraw for carriage-return updates', () => {
    assert.equal(normalizeTerminalPreview('0%\r50%\r100%'), '100%')
  })
})
