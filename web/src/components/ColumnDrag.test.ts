import { describe, expect, it } from 'bun:test'
import { columnVars } from './ColumnDrag'

describe('columnVars', () => {
  it('caps saved widths by the window, so a narrower window keeps the conversation 420px wide', () => {
    expect(columnVars({ left: 300, right: 560 })).toEqual({
      '--left-w': 'min(300px, calc(100vw - 700px))',
      '--right-w': 'max(280px, min(560px, calc(100vw - var(--left-w, 220px) - 420px)))',
    })
    expect(columnVars({})).toEqual({})
  })
})
