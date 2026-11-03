import { describe, expect, it } from 'bun:test'
import { pinComment, readingPage } from './Preview'

describe('PDF scrolling', () => {
  it('counts the page whose top has passed a third of the view as the one being read', () => {
    const tops = [0, 1000, 2000, 3000]
    expect(readingPage(tops, 0, 900)).toBe(1)
    expect(readingPage(tops.map(t => t - 800), 0, 900)).toBe(2)
    expect(readingPage(tops.map(t => t - 2900), 0, 900)).toBe(4)
  })
})

describe('pinned comments', () => {
  it('names the file and where the pin is, as whole percentages', () => {
    expect(pinComment('/w/shot.png', { x: 0.634, y: 0.5449, text: ' too dark ' })).toBe(
      'Comment on `/w/shot.png` (pinned at 63% from the left, 54% from the top): too dark',
    )
  })
  it('adds the page for a PDF', () => {
    expect(pinComment('a.pdf', { x: 0, y: 1, page: 3, text: 'typo' })).toBe(
      'Comment on `a.pdf` (page 3, pinned at 0% from the left, 100% from the top): typo',
    )
  })
})
