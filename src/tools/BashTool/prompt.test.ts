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
    getExcludedCommands: () => [],
    isAutoAllowBashIfSandboxedEnabled: () => false,
    areCommandNetworkListsOffered: () => false,
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
  test('keeps Bash guidance short and limited to what the tool enforces', () => {
    const prompt = getSimplePrompt()

    expect(prompt.startsWith('Executes a bash command and returns its output.')).toBe(true)
    expect(prompt).toContain('reset to the project root if a command leaves it outside the allowed working directories')
    expect(prompt).toContain('Shell state (env vars, functions) does not persist')
    expect(prompt).toContain('Before creating files in a directory you have not inspected')
    expect(prompt).toContain('`timeout` is in milliseconds: default 120000, max 600000.')
    expect(prompt).toContain('multiline scripts are fine')
    expect(prompt).not.toContain('# Instructions')
    expect(prompt).not.toContain('Only commit, push, or create a PR')
    expect(prompt).not.toContain('For git commands:')
    expect(prompt).not.toContain('# Git commits and pull requests')
    expect(prompt).not.toContain('Prefer dedicated tools')
    expect(prompt.length).toBeLessThan(1_400)
  })

  test('mentions run_in_background only when background tasks are enabled', () => {
    expect(getSimplePrompt()).toContain('`run_in_background` runs the command detached')
    process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
    try {
      const prompt = getSimplePrompt()
      expect(prompt).not.toContain('run_in_background')
      expect(prompt).not.toContain('Monitor')
    } finally {
      delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
    }
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
