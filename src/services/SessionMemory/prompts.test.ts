import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSessionMemoryUpdatePrompt } from './prompts.js'

test('does not duplicate project instructions in session memory', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'session-memory-prompt-'))
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir

  try {
    const prompt = await buildSessionMemoryUpdatePrompt(
      '# Current State\n_Description_\nWork in progress',
      '/tmp/session-memory.md',
    )

    expect(prompt).toContain(
      'system prompt, AGENTS.md or CLAUDE.md entries, or any past session summaries',
    )
    expect(prompt).toContain(
      "Do not include information that's already in the AGENTS.md or CLAUDE.md files included in the context",
    )
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
  }
})
