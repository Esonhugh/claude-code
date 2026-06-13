#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderAnsiPreviewLines } from './ansiPreviewRenderer.js'

describe('renderAnsiPreviewLines', () => {
  it('splits a colored preview line into styled segments', () => {
    const lines = renderAnsiPreviewLines('[32mREADY[0m', 80)

    assert.equal(lines.length, 1)
    assert.equal(lines[0]?.segments.length, 1)
    assert.equal(lines[0]?.segments[0]?.text, 'READY')
    assert.ok(lines[0]?.segments[0]?.color)
  })

  it('preserves plain text when there are no ANSI styles', () => {
    const lines = renderAnsiPreviewLines('plain line', 80)

    assert.equal(lines[0]?.segments[0]?.text, 'plain line')
    assert.equal(lines[0]?.segments[0]?.color, undefined)
  })

  it('preserves multiple styled segments on one line', () => {
    const [line] = renderAnsiPreviewLines('A [32mREADY[0m B', 80)

    assert.equal(line?.segments.length, 3)
    assert.equal(line?.segments[1]?.text, 'READY')
    assert.ok(line?.segments[1]?.color)
  })
})
