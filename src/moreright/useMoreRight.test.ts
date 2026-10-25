import { describe, expect, test } from 'bun:test'
import { useMoreRight } from './useMoreRight.js'

describe('useMoreRight stub', () => {
  test('returns the same callbacks on every render', () => {
    const args = {
      enabled: false,
      setMessages: () => {},
      inputValue: '',
      setInputValue: () => {},
      setToolJSX: () => {},
    }
    const first = useMoreRight(args)
    const second = useMoreRight({ ...args, inputValue: 'a' })
    expect(second.onBeforeQuery).toBe(first.onBeforeQuery)
    expect(second.onTurnComplete).toBe(first.onTurnComplete)
    expect(second.render).toBe(first.render)
  })
})
