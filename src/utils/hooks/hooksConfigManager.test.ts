import { expect, test } from 'bun:test'
import { getHookEventMetadata } from './hooksConfigManager.js'

test('describes InstructionsLoaded for both project instruction filenames', () => {
  const metadata = getHookEventMetadata([]).InstructionsLoaded

  expect(metadata.summary).toBe(
    'When an instruction file (AGENTS.md, CLAUDE.md, or rule) is loaded',
  )
})

test('lists the model switch, DirectoryAdded and MessageDisplay events', () => {
  const metadata = getHookEventMetadata([])
  expect(metadata.PreModelSwitch.matcherMetadata?.fieldToMatch).toBe('to_model')
  expect(metadata.PostModelSwitch.matcherMetadata?.fieldToMatch).toBe('to_model')
  expect(metadata.DirectoryAdded.matcherMetadata?.values).toEqual([
    'slash_command',
    'register_repo_root',
  ])
  expect(metadata.MessageDisplay.summary).toBe(
    'While assistant message text is displayed',
  )
})
