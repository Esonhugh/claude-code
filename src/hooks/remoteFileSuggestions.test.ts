import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
import { toRemoteFileSuggestionItems } from './remoteFileSuggestions.js'

describe('remote file suggestion adapter', () => {
  it('preserves remote paths and directory metadata for PromptInput', () => {
    assert.deepEqual(
      toRemoteFileSuggestionItems({
        items: [
          { path: 'src/print.ts', kind: 'file', score: 0.9 },
          { path: 'src/screens', kind: 'directory' },
        ],
        incomplete: false,
      }),
      [
        {
          id: 'file-src/print.ts',
          displayText: 'src/print.ts',
          metadata: { type: 'file', score: 0.9 },
        },
        {
          id: 'file-src/screens/',
          displayText: 'src/screens/',
          metadata: { type: 'directory' },
        },
      ],
    )
  })
})
