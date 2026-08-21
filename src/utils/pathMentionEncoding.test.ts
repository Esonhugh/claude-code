import { describe, expect, test } from 'bun:test'
import {
  decodePathMentionToken,
  encodePathMention,
  extractPathMentions,
} from './pathMentionEncoding.js'

const paths = [
  'simple.txt',
  'dir with spaces/file.txt',
  'report "final".txt',
  'back\\slash.txt',
  '$HOME.txt',
  '$(touch SHOULD_NOT_RUN).txt',
  '`touch SHOULD_NOT_RUN_2`.txt',
  '目录/文件.txt',
]

describe('path mention encoding', () => {
  for (const path of paths) {
    test(`round trips ${JSON.stringify(path)}`, () => {
      const encoded = encodePathMention(path, true).trimEnd()
      expect(decodePathMentionToken(encoded)).toBe(path)
      expect(extractPathMentions(`open ${encoded} now`)).toEqual([path])
    })
  }

  test('leaves an encoded quoted prefix open for continued completion', () => {
    expect(encodePathMention('dir with spaces/', false)).toBe(
      '@"dir with spaces/',
    )
  })

  test('does not include trailing sentence punctuation', () => {
    expect(extractPathMentions('open @file.txt, then @other.ts!')).toEqual([
      'file.txt',
      'other.ts',
    ])
  })
})
