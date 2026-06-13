#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mergePreviewWindow } from './previewWindow.js'

describe('mergePreviewWindow', () => {
  it('keeps the latest terminal lines after CRLF normalization', () => {
    const preview = mergePreviewWindow(
      'bash-5.3$ ',
      'printf "alpha\\n"\r\nalpha\r\nBOLD=[1mbeta[0m\r\ngamma\r\n',
    )

    assert.match(preview, /alpha/)
    assert.match(preview, /BOLD=beta/)
    assert.match(preview, /gamma/)
    assert.equal(preview.includes(String.fromCharCode(27)), false)
  })

  it('collapses carriage-return redraws across streamed chunks for large terminal apps', () => {
    const preview = mergePreviewWindow(
      mergePreviewWindow('', 'Claude is thinking... 12%'),
      '\rClaude is thinking... 100%',
    )

    assert.equal(preview, 'Claude is thinking... 100%')
  })
})
