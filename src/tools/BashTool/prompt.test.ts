import { beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('../../utils/sandbox/sandbox-adapter.js', () => ({
  SandboxManager: { isSandboxingEnabled: () => false },
}))

const { getSimplePrompt } = await import('./prompt.js')

beforeEach(() => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
})

describe('BashTool prompt', () => {
  test('keeps git safety rules compact', () => {
    const prompt = getSimplePrompt()

    expect(prompt).toContain('Only commit, push, or create a PR when explicitly requested')
    expect(prompt).toContain('Never force-push main/master')
    expect(prompt).toContain('skip hooks/signing')
    expect(prompt).toContain('heredoc')
    expect(prompt.length).toBeLessThan(8_500)
  })
})
