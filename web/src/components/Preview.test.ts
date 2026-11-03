import { describe, expect, it } from 'bun:test'
import { columnName, commentText, quoteLine, readingPage } from './Preview'

describe('PDF scrolling', () => {
  it('counts the page whose top has passed a third of the view as the one being read', () => {
    const tops = [0, 1000, 2000, 3000]
    expect(readingPage(tops, 0, 900)).toBe(1)
    expect(readingPage(tops.map(t => t - 800), 0, 900)).toBe(2)
    expect(readingPage(tops.map(t => t - 2900), 0, 900)).toBe(4)
  })
})

describe('comments', () => {
  it('names the file and where the pin is, as whole percentages', () => {
    expect(commentText('`/w/shot.png`', { kind: 'spot', x: 0.634, y: 0.5449 }, ' too dark ')).toBe(
      'Comment on `/w/shot.png` (pinned at 63% from the left, 54% from the top): too dark',
    )
  })
  it('adds the page for a PDF', () => {
    expect(commentText('`a.pdf`', { kind: 'spot', x: 0, y: 1, page: 3 }, 'typo')).toBe(
      'Comment on `a.pdf` (page 3, pinned at 0% from the left, 100% from the top): typo',
    )
  })
  it('names a line or a range of lines', () => {
    expect(commentText('`a.ts`', { kind: 'lines', from: 12, to: 18 }, 'x')).toBe('Comment on `a.ts` (lines 12-18): x')
    expect(commentText('`a.ts`', { kind: 'lines', from: 4, to: 4 }, 'x')).toBe('Comment on `a.ts` (line 4): x')
  })
  it('quotes selected text on one line, shortened', () => {
    expect(commentText('`r.md`', { kind: 'quote', quote: 'Big\n  title', line: 3 }, 'x')).toBe(
      'Comment on `r.md` (line 3, on "Big title"): x',
    )
    const long = commentText('`r.md`', { kind: 'quote', quote: 'a'.repeat(200) }, 'x')
    expect(long).toContain(`on "${'a'.repeat(120)}…"`)
  })
  it('names a cell and its sheet', () => {
    expect(commentText('`b.xlsx`', { kind: 'cell', ref: 'B3', sheet: 'Q1' }, 'x')).toBe(
      'Comment on `b.xlsx` (sheet "Q1", cell B3): x',
    )
    expect(commentText('`t.csv`', { kind: 'cell', ref: 'A1' }, 'x')).toBe('Comment on `t.csv` (cell A1): x')
  })
  it('finds the line of a quote only when the source has it once', () => {
    expect(quoteLine('# Title\n\nsome text\nmore', 'some text\nmore')).toBe(3)
    expect(quoteLine('a\nb\na', 'a')).toBeUndefined()
    expect(quoteLine('**bold** text', 'bold text')).toBeUndefined()
  })
  it('names columns the way a spreadsheet does', () => {
    expect([0, 1, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  })
})
