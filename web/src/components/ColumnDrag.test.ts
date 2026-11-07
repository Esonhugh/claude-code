import { describe, expect, it } from 'bun:test'
import { clampColumn, columnVars } from './ColumnDrag'

describe('columnVars', () => {
  it('caps saved widths by the window, so a narrower window keeps the conversation 420px wide', () => {
    expect(columnVars({ left: 300, right: 560 })).toEqual({
      '--left-w': 'min(300px, calc(100vw - 700px))',
      '--right-w': 'max(280px, min(560px, calc(100vw - var(--left-w, 220px) - 420px)))',
    })
    expect(columnVars({})).toEqual({})
  })
})

describe('the conversation beside a file preview', () => {
  it('saves its own width, capped so the preview keeps 420px', () => {
    expect(columnVars({ chat: 600 })).toEqual({
      '--chat-w': 'max(340px, min(600px, calc(100vw - var(--left-w, 220px) - 420px)))',
    })
    expect(clampColumn('chat', 200, 1440, 220)).toBe(340)
    expect(clampColumn('chat', 700, 1440, 220)).toBe(700)
    expect(clampColumn('chat', 1000, 1440, 220)).toBe(800)
  })
})
