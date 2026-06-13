#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createTerminalScreen,
  lineText,
  moveCursorToColumn,
  moveCursorToNextRow,
  writeCharToScreen,
} from './terminalScreen.js'

describe('terminalScreen', () => {
  it('writes printable characters using cols and rows', () => {
    const screen = createTerminalScreen(5, 2)
    writeCharToScreen(screen, 'h')
    writeCharToScreen(screen, 'e')
    writeCharToScreen(screen, 'l')
    writeCharToScreen(screen, 'l')
    writeCharToScreen(screen, 'o')

    assert.equal(lineText(screen, 0), 'hello')
  })

  it('supports carriage-return style overwrite at the current row', () => {
    const screen = createTerminalScreen(12, 2)
    'progress 12'.split('').forEach(char => writeCharToScreen(screen, char))
    moveCursorToColumn(screen, 0)
    'done'.split('').forEach(char => writeCharToScreen(screen, char))

    assert.equal(lineText(screen, 0).startsWith('done'), true)
  })

  it('moves to the next row and scrolls when output exceeds the visible screen', () => {
    const screen = createTerminalScreen(5, 2)
    'line1\nline2\nline3'
      .split('')
      .forEach(char => {
        if (char === '\n') {
          moveCursorToNextRow(screen)
        } else {
          writeCharToScreen(screen, char)
        }
      })

    assert.equal(lineText(screen, 0), 'line2')
    assert.equal(lineText(screen, 1), 'line3')
  })
})
