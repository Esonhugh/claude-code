import { describe, expect, test } from 'bun:test'

import {
  getAllReleaseNotes,
  getRecentReleaseNotes,
  parseChangelog,
} from './releaseNotes.js'

const releaseChangelog = `# 变更日志

## 2026-07-25 - v2.1.205 - Future release

### 变更内容

- Future change

## 2026-07-24 - v2.1.204 - Current release

### 变更内容

- Current change

## 2026-07-23 - v2.1.203 - Previous release

### 变更内容

- Previous change
`

describe('release notes', () => {
  test('parses only versioned release change sections', () => {
    expect(parseChangelog(releaseChangelog)).toEqual({
      '2.1.205': ['Future change'],
      '2.1.204': ['Current change'],
      '2.1.203': ['Previous change'],
    })
  })

  test('limits recent notes to the current binary version', () => {
    expect(getRecentReleaseNotes('2.1.204', '2.1.203', releaseChangelog)).toEqual([
      'Current change',
    ])
  })

  test('parses the bundled project changelog', () => {
    const bundledNotes = getAllReleaseNotes()
    expect(bundledNotes.length).toBeGreaterThan(0)
    expect(bundledNotes.at(-1)?.[1].length).toBeGreaterThan(0)
  })
})
