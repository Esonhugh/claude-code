import { expect, test } from 'bun:test'
import { createScreen, CharPool, HyperlinkPool, StylePool } from './screen.js'
import { serializeValidationFrame } from './terminalEvidence.js'

test('native evidence records terminal geometry separately from the alt-screen sentinel viewport', () => {
  const frame = {
    screen: createScreen(110, 34, new StylePool(), new CharPool(), new HyperlinkPool()),
    viewport: { width: 110, height: 35 },
    cursor: { x: 0, y: 0, visible: false },
  }
  const recorded = JSON.parse(Buffer.from(
    serializeValidationFrame(frame, frame.cursor, 'alternate', { width: 110, height: 34 }),
    'base64').toString('utf8'))
  expect(recorded.viewport).toEqual({ width: 110, height: 34 })
  expect(recorded.logicalViewport).toEqual(frame.viewport)
  expect(recorded.rows).toBe(34)
})
