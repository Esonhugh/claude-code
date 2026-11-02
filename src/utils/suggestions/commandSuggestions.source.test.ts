import { describe, expect, test } from 'bun:test'
import type { Command } from '../../types/command.js'
import {
  generateCommandSuggestions,
  shouldPreselectCommandSuggestion,
} from './commandSuggestions.js'

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

describe('command suggestion preselection', () => {
  const commands = [skill('batch'), skill('help'), skill('mt-hello'), skill('code-review')]
  const top = (input: string, name: string) =>
    generateCommandSuggestions(input, commands).filter(
      s => s.displayText === `/${name}`,
    )

  test('preselects when the input starts a word of the top command (official 2.1.311)', () => {
    expect(shouldPreselectCommandSuggestion('/', top('/', 'batch'))).toBe(true)
    expect(shouldPreselectCommandSuggestion('/ba', top('/ba', 'batch'))).toBe(true)
    expect(shouldPreselectCommandSuggestion('/rev', top('/rev', 'code-review'))).toBe(true)
    expect(shouldPreselectCommandSuggestion('/codere', top('/codere', 'code-review'))).toBe(true)
  })

  test('does not preselect a fuzzy match, so Enter submits what was typed', () => {
    expect(shouldPreselectCommandSuggestion('/plan', top('/plan', 'batch'))).toBe(false)
    expect(shouldPreselectCommandSuggestion('/hepl', top('/hepl', 'mt-hello'))).toBe(false)
    expect(shouldPreselectCommandSuggestion('/hepl', [])).toBe(false)
  })
})
