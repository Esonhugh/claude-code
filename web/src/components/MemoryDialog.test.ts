import { expect, test } from 'bun:test'
import { matchRanges } from './MemoryDialog'

test('matchRanges finds every word of a multi-word query, case-insensitively', () => {
  const text = '記憶 uses SQLite; 搜索 the sqlite index'
  expect(matchRanges(text, '搜索 sqlite 記憶').map(([a, b]) => text.slice(a, b))).toEqual(['記憶', 'SQLite', '搜索', 'sqlite'])
  expect(matchRanges(text, '')).toEqual([])
  expect(matchRanges('sqlite', 'sql sqlite').map(([a, b]) => b - a)).toEqual([6])
})
