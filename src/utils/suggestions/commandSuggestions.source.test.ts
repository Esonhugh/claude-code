import { describe, expect, test } from 'bun:test'
import type { Command } from '../../types/command.js'
import { generateCommandSuggestions } from './commandSuggestions.js'

function skill(name: string, mcpServerName?: string): Command {
  return {
    type: 'prompt',
    name,
    description: 'Skill description',
    contentLength: 0,
    progressMessage: 'running',
    source: 'mcp',
    loadedFrom: mcpServerName === 'codex_apps' ? 'codex_app' : 'mcp',
    mcpServerName,
    userInvocable: true,
    isHidden: false,
    getPromptForCommand: async () => [],
  }
}

describe('skill source suggestions', () => {
  test('shows Codex as the source for Codex Apps skills', () => {
    const [suggestion] = generateCommandSuggestions('/', [
      skill('code-review', 'codex_apps'),
    ])

    expect(suggestion).toMatchObject({
      displayText: '/code-review',
      description: 'Skill description (Codex)',
    })
  })

  test('does not add a source suffix for ordinary MCP skills', () => {
    const [suggestion] = generateCommandSuggestions('/', [skill('review')])

    expect(suggestion?.description).toBe('Skill description')
  })
})
