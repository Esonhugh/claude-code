import { expect, test } from 'bun:test'
import { emptyPreview, matchRanges, snippetParts } from './MemoryDialog'

test('matchRanges finds every word of a multi-word query, case-insensitively', () => {
  const text = '記憶 uses SQLite; 搜索 the sqlite index'
  expect(matchRanges(text, '搜索 sqlite 記憶').map(([a, b]) => text.slice(a, b))).toEqual(['記憶', 'SQLite', '搜索', 'sqlite'])
  expect(matchRanges(text, '')).toEqual([])
  expect(matchRanges('sqlite', 'sql sqlite').map(([a, b]) => b - a)).toEqual([6])
})

test('snippetParts takes the match by offset, not by brackets in the text', () => {
  const snippet = '- [[release]](release.md) see [DB]'
  expect(snippetParts({ snippet, match: [3, 12] })).toEqual(['- [', 'release', '](release.md) see [DB]'])
  expect(snippetParts({ snippet: 'no match [x]' })).toEqual(['no match [x]', '', ''])
})

test('emptyPreview says a missing or empty file has no text, instead of a blank pane', () => {
  expect(emptyPreview({ missing: true, body: '' })).toBe('此文件还不存在。')
  expect(emptyPreview({ body: ' \n' })).toBe('此文件为空。')
  expect(emptyPreview({ body: '# rules' })).toBeUndefined()
})
