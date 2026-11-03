import { describe, expect, it } from 'bun:test'
import { followScroll } from './ui'

describe('followScroll', () => {
  const at = (scrollTop: number) => ({ scrollHeight: 2000, clientHeight: 500, scrollTop })

  it('stops following when the reader scrolls up, even while output keeps coming', () => {
    const top = { current: 1500 }
    expect(followScroll(at(1200), true, top)).toBe(false)
    // More output grew the feed; the reader stays where they scrolled to.
    expect(followScroll(at(1200), false, top)).toBe(false)
    expect(followScroll(at(1300), false, top)).toBe(false)
  })

  it('follows again at the bottom, and keeps following when a late event lands mid-feed', () => {
    const top = { current: 0 }
    expect(followScroll(at(1480), false, top)).toBe(true)
    expect(followScroll(at(1490), true, top)).toBe(true)
  })
})
