#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  applyTerminalOutput,
  createTerminalScreenRenderer,
  renderedPreview,
  resizeTerminalScreenRenderer,
} from './terminalScreenRenderer.js'

describe('terminalScreenRenderer', () => {
  it('collapses large-terminal carriage-return redraws into the final visible row', () => {
    const renderer = createTerminalScreenRenderer(40, 6)

    applyTerminalOutput(renderer, 'Claude is thinking... 12%')
    applyTerminalOutput(renderer, '\rClaude is thinking... 100%')

    const preview = renderedPreview(renderer)
    assert.equal(preview.includes('Claude is thinking... 100%'), true)
    assert.equal(preview.includes('Claude is thinking... 12%'), false)
  })

  it('renders ANSI-styled output as plain snapshot text without leaking control bytes', () => {
    const renderer = createTerminalScreenRenderer(40, 6)

    applyTerminalOutput(renderer, 'A [31mred[0m B')

    const preview = renderedPreview(renderer)
    assert.equal(preview.includes('A red B'), true)
    assert.equal(preview.includes('[31mred[0m'), false)
    assert.equal(preview.includes('[H'), false)
  })

  it('handles CSI sequences split across chunks', () => {
    const renderer = createTerminalScreenRenderer(40, 6)

    applyTerminalOutput(renderer, '[31')
    applyTerminalOutput(renderer, 'mred')

    assert.equal(renderedPreview(renderer).includes('red'), true)
  })

  it('updates the visible screen when resized', () => {
    const renderer = createTerminalScreenRenderer(10, 4)

    applyTerminalOutput(renderer, '0123456789')
    resizeTerminalScreenRenderer(renderer, 5, 4)

    assert.equal(renderedPreview(renderer).length > 0, true)
  })

  it('keeps multi-line large terminal output as a visible row window instead of flattening it', () => {
    const renderer = createTerminalScreenRenderer(40, 6)

    applyTerminalOutput(renderer, '[32mREADY[0m\n')
    applyTerminalOutput(renderer, 'Claude thinking 12%\rClaude thinking 100%\n')
    applyTerminalOutput(
      renderer,
      'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\n',
    )
    applyTerminalOutput(renderer, 'bash-5.3$ ')

    const preview = renderedPreview(renderer)
    assert.equal(preview.includes('line8'), true)
    assert.equal(preview.includes('line10'), true)
    assert.equal(preview.includes('line11'), true)
    assert.equal(preview.includes('bash-5.3$'), true)
    assert.equal(preview.includes('\n'), true)
  })

  it('ignores OSC metadata sequences from interactive shells', () => {
    const renderer = createTerminalScreenRenderer(40, 6)

    applyTerminalOutput(renderer, 'bash-5.3$ ')
    applyTerminalOutput(renderer, ']697;DoneSourcing')
    applyTerminalOutput(renderer, '[32mREADY[0m\n')

    const preview = renderedPreview(renderer)
    assert.equal(preview.includes('697;DoneSourcing'), false)
    assert.equal(preview.includes('READY'), true)
  })

  it('renders cursor-positioned overwrites as the final visible screen', () => {
    const renderer = createTerminalScreenRenderer(20, 4)

    applyTerminalOutput(renderer, 'first line\nsecond line')
    applyTerminalOutput(renderer, '[1;1Htop')

    const preview = renderedPreview(renderer)
    assert.equal(preview.includes('topst line'), true)
    assert.equal(preview.includes('\u001b[1;1H'), false)
  })

  it('renders clear-screen redraws as a current screen snapshot', () => {
    const renderer = createTerminalScreenRenderer(20, 4)

    applyTerminalOutput(renderer, 'old output\n')
    applyTerminalOutput(renderer, '[2J[Hnew prompt')

    const preview = renderedPreview(renderer)
    assert.equal(preview.includes('old output'), false)
    assert.equal(preview.includes('new prompt'), true)
  })
})
