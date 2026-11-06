import { describe, expect, it } from 'bun:test'
import { compactHint, followScroll, modeOf, type T } from './ui'

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

describe('compactHint', () => {
  const t = ((key: string, vars?: Record<string, string>) => `${key}${vars ? ` ${vars.n}` : ''}`) as T
  const fmt = (n: number) => String(n)

  it('counts down to the threshold instead of showing the fixed buffer', () => {
    expect(compactHint(t, 56_000, 167_000, fmt)).toBe('compactIn 111000')
    expect(compactHint(t, 150_000, 167_000, fmt)).toBe('compactIn 17000')
  })

  it('says the point is passed when the conversation is over the threshold', () => {
    expect(compactHint(t, 241_000, 167_000, fmt)).toBe('compactDue')
  })
})

describe('modeOf', () => {
  it('names the default mode as the TUI footer does', () => {
    expect(modeOf('default').label).toBe('manual mode on')
    expect(modeOf(undefined).label).toBe('manual mode on')
  })
})
