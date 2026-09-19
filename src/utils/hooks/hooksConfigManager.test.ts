import { expect, test } from 'bun:test'
import { getHookEventMetadata } from './hooksConfigManager.js'

test('describes InstructionsLoaded for both project instruction filenames', () => {
  const metadata = getHookEventMetadata([]).InstructionsLoaded

  expect(metadata.summary).toBe(
    'When an instruction file (AGENTS.md, CLAUDE.md, or rule) is loaded',
  )
})
