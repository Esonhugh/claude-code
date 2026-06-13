#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTerminalScreen, writeCharToScreen } from './terminalScreen.js'
import { screenToPreview } from './terminalScreenToPreview.js'

describe('terminalScreenToPreview', () => {
  it('renders screen rows into preview text', () => {
    const screen = createTerminalScreen(8, 2)
    'preview'.split('').forEach(char => writeCharToScreen(screen, char))

    assert.equal(screenToPreview(screen).includes('preview'), true)
  })
})
