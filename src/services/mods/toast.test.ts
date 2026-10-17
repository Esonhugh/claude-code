import { expect, test } from 'bun:test'
import { createModToasts } from './toast.js'

test('uses default timeout and independently throttles each plugin', () => {
  let now = 0
  const shown: unknown[] = []
  const dropped: string[] = []
  const toast = createModToasts({
    now: () => now,
    show: (...args) => { shown.push(args) },
    dropped: plugin => { dropped.push(plugin) },
  })
  toast('one', { text: 'first' })
  toast('one', { text: 'second' })
  toast('two', { text: 'other', timeoutMs: 1 })
  expect(shown).toEqual([['one', 'first', 4000], ['two', 'other', 1]])
  expect(dropped).toEqual(['one'])
  now = 2000
  toast('one', { text: 'later', timeoutMs: 60000 })
  expect(shown.at(-1)).toEqual(['one', 'later', 60000])
})

test('limits original toast text to 4096 UTF-16 units before throttling', () => {
  const shown: unknown[] = []
  const toast = createModToasts({ now: () => 0, show: (...args) => { shown.push(args) } })
  for (const text of ['a'.repeat(4097), 'a' + ' '.repeat(4096), '\u{10400}'.repeat(2049)]) {
    expect(() => toast('invalid', { text })).toThrow('4096')
  }
  expect(shown).toEqual([])
  toast('invalid', { text: 'valid' })
  for (const [index, text] of ['界'.repeat(4096), 'a' + ' '.repeat(4095), '\u{10400}'.repeat(2048)].entries()) {
    toast(String(index), { text })
    expect(shown.at(-1)).toEqual([String(index), text, 4000])
  }
  expect(shown[0]).toEqual(['invalid', 'valid', 4000])
})

test('rejects invalid host payloads before consuming the throttle window', () => {
  const shown: unknown[] = []
  const toast = createModToasts({ now: () => 0, show: (...args) => { shown.push(args) } })
  for (const timeoutMs of [0, 60001, 1.5, NaN, '100', null]) {
    expect(() => toast('one', { text: 'invalid', timeoutMs })).toThrow()
  }
  for (const text of ['', ' ', null, 1]) expect(() => toast('one', { text })).toThrow()
  toast('one', { text: 'valid' })
  expect(shown).toEqual([['one', 'valid', 4000]])
})
