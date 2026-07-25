import { describe, expect, test } from 'bun:test'

import { parseChangelog, validateChangelog } from './changelog.js'

const validChangelog = `# 变更日志

## 2026-07-24 - v2.1.204 - Latest release

### 版本状态

- 发布版本：v2.1.204。

### 关联提交

- abc123 - Release commit

### 变更内容

#### Feature

- First change
- Second change

### 测试覆盖

- Tests passed

## 2026-07-23 - Work in progress

### 关联提交

- def456 - Unreleased commit

### 变更内容

- Unreleased change

## 2.1.88 base

### 基线说明

- Base release
`

const invalidChangelog = `# Wrong title

## 2026-07-24 - v2.1.203 - Older release

### 关联提交

- abc123

### 版本状态

- Released

### 变更内容

- First change。 - Second change

### 验证状态

-

## 2026-07-25 - Follow-up for v2.1.203

- Invalid unversioned heading

## 2026-02-30 - v2.1.203 - Duplicate release

### 版本状态

- Released

### 关联提交

- def456

### 变更内容

- Duplicate

### 测试覆盖

- Tests passed

## 2.1.88 base

### 基线说明

- Base release
`

describe('changelog format', () => {
  test('parses valid versioned entries and ignores other entry types', () => {
    expect(validateChangelog(validChangelog)).toEqual({
      errors: [],
      releases: [
        {
          date: '2026-07-24',
          version: '2.1.204',
          title: 'Latest release',
          line: 3,
          notes: ['First change', 'Second change'],
        },
      ],
    })
    expect(parseChangelog(validChangelog)).toEqual({
      '2.1.204': ['First change', 'Second change'],
    })
    expect(validateChangelog(validChangelog, 'v2.1.204').errors).toEqual([])
  })

  test('reports malformed structure and release mismatches', () => {
    const errors = validateChangelog(invalidChangelog, '2.1.204').errors
    for (const expected of [
      'line 1: changelog must start with "# 变更日志"',
      'release sections must be exactly',
      'release note bullets must use separate lines',
      'must contain a non-empty top-level bullet',
      'unversioned entry title must not contain a semantic version',
      'invalid calendar date "2026-02-30"',
      'duplicate release version v2.1.203',
      'release versions must be strictly descending',
      'latest release version must be v2.1.204, got v2.1.203',
    ]) {
      expect(errors.some(error => error.includes(expected))).toBe(true)
    }
  })
})
