import { expect, test } from 'bun:test'
import { DEFAULT_BINDINGS } from './defaultBindings.js'
import { KEYBINDING_ACTIONS } from './schema.js'

test('chat queue submission is a public action bound to ctrl+x enter', () => {
  expect(KEYBINDING_ACTIONS).toContain('chat:queueSubmit')
  expect(
    DEFAULT_BINDINGS.find(block => block.context === 'Chat')?.bindings[
      'ctrl+x enter'
    ],
  ).toBe('chat:queueSubmit')
})
