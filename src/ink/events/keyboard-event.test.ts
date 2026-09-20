import { expect, test } from 'bun:test'
import { INITIAL_STATE, parseMultipleKeypresses } from '../parse-keypress.js'
import { KeyboardEvent } from './keyboard-event.js'

function events(input: string): KeyboardEvent[] {
  const [parsed] = parseMultipleKeypresses(INITIAL_STATE, input)
  return parsed.map(key => {
    if (key.kind !== 'key') throw new Error('Expected a keyboard event')
    return new KeyboardEvent(key)
  })
}

test.each(['sample-input', '中文输入', 'return', 'tab', 'backspace', 'delete', 'up'])('preserves literal text %s separately from special keys', input => {
  const [event] = events(input)
  expect(event?.text).toBe(input)
  expect(event?.isPasted).toBe(false)
})

test('separates control keys from a bulk text chunk outside paste', () => {
  expect(events('hello\t中文\x7f\r').map(event => [event.key, event.text])).toEqual([
    ['hello', 'hello'], ['tab', undefined], ['中文', '中文'],
    ['backspace', undefined], ['return', undefined],
  ])
})

test.each(['return', 'tab', 'a\r\t中文', '\x1b[A', ''])('keeps bracketed paste payload literal: %j', input => {
  const parsed = events(`\x1b[200~${input}\x1b[201~\r`)
  expect(parsed).toHaveLength(2)
  expect(parsed[0]?.text).toBe(input)
  expect(parsed[0]?.isPasted).toBe(true)
  expect(parsed[1]?.key).toBe('return')
  expect(parsed[1]?.text).toBeUndefined()
})

test.each(['\r', '\t', '\x7f', '\x1b[A', '\x1bOP', '\x1b[25~', '\x1b[57358u', '\x01', '\x1bx', '\x1b[97;9u'])('does not expose special or modified key %j as text', input => {
  const [event] = events(input)
  expect(event?.text).toBeUndefined()
  expect(event?.isPasted).toBe(false)
})

test('preserves decoded printable keys from terminal keyboard protocols', () => {
  expect(events('\x1b[97u\x1b[32u\x1b[27;1;98~\x1bOp').map(event => event.text)).toEqual(['a', ' ', 'b', '0'])
})
