import { afterEach, describe, expect, mock, test } from 'bun:test'
import { asSessionId } from '../types/ids.js'
import type { Tools } from '../Tool.js'

const filesystemModule = await import('../utils/permissions/filesystem.js')
const stateModule = await import('../bootstrap/state.js')
const originalSessionId = stateModule.getSessionId()
const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY
mock.module('../utils/permissions/filesystem.js', () => ({
  ...filesystemModule,
  getScratchpadDir: () =>
    `/tmp/claude/session/${stateModule.getSessionId()}/scratchpad`,
  isScratchpadEnabled: () => true,
}))

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
  ISSUES_EXPLAINER: 'report an issue',
}

const { getScratchpadInstructions, getSystemPrompt } = await import('./prompts.js')
const { clearSystemPromptSections } = await import('./systemPromptSections.js')

afterEach(() => {
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY
  }
  clearSystemPromptSections()
  stateModule.switchSession(originalSessionId)
})

describe('scratchpad prompt', () => {
  test('uses scratchpad for session artifacts rather than command-local temp files', () => {
    const prompt = getScratchpadInstructions()

    expect(prompt).toContain('persist across tool calls')
    expect(prompt).toContain('session working artifacts')
    expect(prompt).toContain('Inside a Bash command, use `$TMPDIR`')
    expect(prompt).not.toContain('Always use this scratchpad directory')
    expect(prompt).not.toContain('ALL temporary file needs')
  })

  test('updates session-specific scratchpad path after switching sessions', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'

    const firstPrompt = await getSystemPrompt(
      [] as unknown as Tools,
      'claude-opus-4-6',
    )
    expect(firstPrompt.join('\n')).toContain(originalSessionId)

    stateModule.switchSession(
      asSessionId('00000000-0000-4000-8000-000000000001'),
    )
    const secondPrompt = await getSystemPrompt(
      [] as unknown as Tools,
      'claude-opus-4-6',
    )

    const secondRenderedPrompt = secondPrompt.join('\n')
    expect(secondRenderedPrompt).toContain(
      '/tmp/claude/session/00000000-0000-4000-8000-000000000001/scratchpad',
    )
    expect(secondRenderedPrompt).not.toContain(
      `/tmp/claude/session/${originalSessionId}/scratchpad`,
    )
  })
})
