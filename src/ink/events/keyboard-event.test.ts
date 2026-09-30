import { expect, test } from 'bun:test'
import { INITIAL_STATE, parseMultipleKeypresses } from '../parse-keypress.js'
import { InputEvent } from './input-event.js'
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

test('preserves Unicode text encoded by the Kitty keyboard protocol', () => {
  const [parsed] = parseMultipleKeypresses(
    INITIAL_STATE,
    '\x1b[20013u\x1b[25991u',
  )
  const keys = parsed.map(key => {
    if (key.kind !== 'key') throw new Error('Expected a keyboard event')
    return key
  })
  expect(keys.map(key => new KeyboardEvent(key).text)).toEqual(['中', '文'])
  expect(keys.map(key => new InputEvent(key).input)).toEqual(['中', '文'])
})

test('flushes an unfinished bracketed paste and returns to normal input', () => {
  const [initial, pending] = parseMultipleKeypresses(
    INITIAL_STATE,
    '\x1b[200~中文',
  )
  expect(initial).toEqual([])
  expect(pending.mode).toBe('IN_PASTE')
  expect(pending.incomplete).toBe('')

  const [flushed, normal] = parseMultipleKeypresses(pending, null)
  expect(flushed).toHaveLength(1)
  expect(flushed[0]?.kind).toBe('key')
  if (flushed[0]?.kind !== 'key') throw new Error('Expected paste key')
  expect(new KeyboardEvent(flushed[0]).text).toBe('中文')
  expect(normal.mode).toBe('RECOVERING_PASTE')
})

test('flushes an empty unfinished bracketed paste', () => {
  const [, pending] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~')
  const [flushed, recovering] = parseMultipleKeypresses(pending, null)
  expect(flushed).toHaveLength(1)
  expect(recovering.mode).toBe('RECOVERING_PASTE')
})

test('keeps late bracketed-paste continuation literal after recovery', () => {
  const [, pending] = parseMultipleKeypresses(
    INITIAL_STATE,
    '\x1b[200~first',
  )
  const [flushed, recovering] = parseMultipleKeypresses(pending, null)
  expect(flushed).toHaveLength(1)

  const [continuation, normal] = parseMultipleKeypresses(
    recovering,
    'second\r\t\x1b[201~',
  )
  expect(continuation).toHaveLength(1)
  expect(continuation[0]?.kind).toBe('key')
  if (continuation[0]?.kind !== 'key') throw new Error('Expected paste key')
  expect(new KeyboardEvent(continuation[0]).text).toBe('second\r\t')
  expect(normal.mode).toBe('NORMAL')
})

test('ignores a paste terminator that arrives after recovered content was emitted', () => {
  const [, pending] = parseMultipleKeypresses(
    INITIAL_STATE,
    '\x1b[200~first',
  )
  const [flushed, recovering] = parseMultipleKeypresses(pending, null)
  expect(flushed).toHaveLength(1)

  const [lateEnd, normal] = parseMultipleKeypresses(
    recovering,
    '\x1b[201~',
  )
  expect(lateEnd).toEqual([])
  expect(normal.mode).toBe('NORMAL')
})

test('ignores an orphaned paste terminator during ordinary input', () => {
  const [parsed, normal] = parseMultipleKeypresses(
    INITIAL_STATE,
    '\x1b[201~next',
  )
  expect(parsed.map(key => key.kind === 'key'
    ? [new KeyboardEvent(key).text, new KeyboardEvent(key).isPasted]
    : undefined)).toEqual([
    ['next', false],
  ])
  expect(normal.mode).toBe('NORMAL')
})

test('ends paste recovery after another idle flush', () => {
  const [, pending] = parseMultipleKeypresses(
    INITIAL_STATE,
    '\x1b[200~first',
  )
  const [, recovering] = parseMultipleKeypresses(pending, null)
  const [empty, normal] = parseMultipleKeypresses(recovering, null)

  expect(empty).toEqual([])
  expect(normal.mode).toBe('NORMAL')

  const [ordinary] = parseMultipleKeypresses(normal, 'next\r')
  expect(ordinary.map(key => key.kind === 'key'
    ? [new KeyboardEvent(key).text, new KeyboardEvent(key).key]
    : undefined)).toEqual([
    ['next', 'next'],
    [undefined, 'return'],
  ])
})

test('releases late paste continuation on the recovery idle flush', () => {
  const [, pending] = parseMultipleKeypresses(
    INITIAL_STATE,
    '\x1b[200~first',
  )
  const [, recovering] = parseMultipleKeypresses(pending, null)
  const [waiting, continued] = parseMultipleKeypresses(recovering, 'second\r\t')
  expect(waiting).toEqual([])

  const [flushed, normal] = parseMultipleKeypresses(continued, null)
  expect(flushed).toHaveLength(1)
  expect(flushed[0]?.kind).toBe('key')
  if (flushed[0]?.kind !== 'key') throw new Error('Expected paste key')
  expect(new KeyboardEvent(flushed[0]).text).toBe('second\r\t')
  expect(normal.mode).toBe('NORMAL')
})
