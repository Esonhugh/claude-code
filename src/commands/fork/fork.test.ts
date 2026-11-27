import { expect, test } from 'bun:test'
import { forkName, forkRefusal } from './fork.js'

test('a fork is named after its parent and prompt, like 2.1.329', () => {
  expect(forkName('PONG reply', 'Reply with just the word FORKED.')).toBe('PONG reply ⑂ Reply with just the word FORKED.')
  expect(forkName('PONG reply', undefined)).toBe('PONG reply ⑂')
  expect(forkName(undefined, 'check\n  the build')).toBe('⑂ check the build')
  expect(forkName(undefined, undefined)).toBeUndefined()
  expect(forkName('p', 'x'.repeat(80))).toBe(`p ⑂ ${'x'.repeat(60)}`)
})

test('an empty conversation is not forked', () => {
  expect(forkRefusal(false)).toBe('Nothing to fork yet. Send a message first.')
  expect(forkRefusal(true)).toBeUndefined()
})
