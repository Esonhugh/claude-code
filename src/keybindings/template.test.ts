import { expect, test } from 'bun:test'
import { generateKeybindingsTemplate } from './template.js'
import { validateBindings } from './validate.js'

test('the /keybindings template passes its own validation', () => {
  const { bindings } = JSON.parse(generateKeybindingsTemplate())
  const errors = validateBindings(bindings, []).filter(w => w.severity === 'error')
  expect(errors).toEqual([])
})
