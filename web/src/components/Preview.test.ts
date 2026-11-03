import { describe, expect, it } from 'bun:test'
import { readingPage } from './Preview'

describe('PDF scrolling', () => {
  it('counts the page whose top has passed a third of the view as the one being read', () => {
    const tops = [0, 1000, 2000, 3000]
    expect(readingPage(tops, 0, 900)).toBe(1)
    expect(readingPage(tops.map(t => t - 800), 0, 900)).toBe(2)
    expect(readingPage(tops.map(t => t - 2900), 0, 900)).toBe(4)
  })
})
