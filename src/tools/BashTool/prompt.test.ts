import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const originalSimple = process.env.CLAUDE_CODE_SIMPLE
let sandboxEnabled = false

mock.module('../../utils/sandbox/sandbox-adapter.js', () => ({
  SandboxManager: {
    isSandboxingEnabled: () => sandboxEnabled,
    getFsReadConfig: () => ({ denyOnly: [] }),
    getFsWriteConfig: () => ({ allowOnly: [], denyWithinAllow: [] }),
    getNetworkRestrictionConfig: () => null,
    getAllowUnixSockets: () => [],
    getIgnoreViolations: () => null,
    areUnsandboxedCommandsAllowed: () => false,
  },
}))

const { getSimplePrompt } = await import('./prompt.js')

beforeEach(() => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  sandboxEnabled = false
})

afterEach(() => {
  if (originalSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = originalSimple
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

  test('scopes TMPDIR to command-local sandbox files', () => {
    sandboxEnabled = true

    const prompt = getSimplePrompt()

    expect(prompt).toContain('command-local temporary files')
    expect(prompt).toContain('use the `$TMPDIR` environment variable')
    expect(prompt).not.toContain('For temporary files, always use')
  })
})
