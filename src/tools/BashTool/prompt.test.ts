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

const { zodToJsonSchema } = await import('../../utils/zodToJsonSchema.js')
const { BashTool } = await import('./BashTool.js')
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
  test('keeps Bash-specific guidance without git workflow instructions', () => {
    const prompt = getSimplePrompt()

    expect(prompt).toContain('Executes a given bash command')
    expect(prompt).not.toContain('Avoid using this tool to run')
    expect(prompt).not.toContain('While the Bash tool can do similar things')
    expect(prompt).toContain('If your command will create new directories or files in a directory you have not inspected')
    expect(prompt).toContain('`cd` is allowed when it improves command readability')
    expect(prompt).toContain('Multiline scripts are allowed')
    expect(prompt).not.toContain('Only commit, push, or create a PR')
    expect(prompt).not.toContain('For git commands:')
    expect(prompt).not.toContain('DO NOT use newlines to separate commands')
    expect(prompt).not.toContain('avoiding usage of `cd`')
    expect(prompt.length).toBeLessThan(7_000)
  })

  test('keeps policy ownership consistent outside simple mode', () => {
    delete process.env.CLAUDE_CODE_SIMPLE
    const prompt = getSimplePrompt()

    expect(prompt).not.toContain('# Git commits and pull requests')
    expect(prompt).not.toContain('For a commit:')
    expect(prompt).not.toContain('For a pull request:')
    expect(prompt).not.toContain('independent tool calls in parallel')
    expect(prompt).not.toContain('Prefer dedicated tools')
    expect(prompt).toContain('in a directory you have not inspected')
    expect(prompt).not.toContain('If your command will create new directories or files, first')
    expect(prompt).toContain('`cd` is allowed')
    expect(prompt).toContain('Multiline scripts are allowed')
    expect(prompt).toContain('shell state does not')
  })

  test('scopes TMPDIR to command-local sandbox files', () => {
    sandboxEnabled = true

    const prompt = getSimplePrompt()

    expect(prompt).toContain('command-local temporary files')
    expect(prompt).toContain('use the `$TMPDIR` environment variable')
    expect(prompt).not.toContain('For temporary files, always use')
  })

  test('keeps description parameter concise without examples or banned words', () => {
    const schema = zodToJsonSchema(BashTool.inputSchema) as {
      properties?: { description?: { description?: string } }
    }
    const description = schema.properties?.description?.description ?? ''

    expect(schema.properties?.description).toBeDefined()
    expect(description.length).toBeLessThan(220)
    expect(description).toContain('Clear, concise description')
    expect(description).not.toContain('Never use words like')
    expect(description).not.toContain('Find and delete all .tmp files recursively')
    expect(description).not.toContain('Discard all local changes and match remote main')
  })
})
