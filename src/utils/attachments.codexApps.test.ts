import { describe, expect, test } from 'bun:test'
import {
  extractAtMentionedFiles,
  extractMcpResourceMentions,
} from './attachments.js'

describe('@codex-app mentions', () => {
  test('are not treated as files or MCP resources', () => {
    const input = 'Use @codex-app:github to inspect the pull request'

    expect(extractAtMentionedFiles(input)).toEqual([])
    expect(extractMcpResourceMentions(input)).toEqual([])
  })
})
