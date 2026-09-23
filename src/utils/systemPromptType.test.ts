import { describe, expect, test } from 'bun:test'
import {
  asSystemPrompt,
  concatSystemPrompts,
  getSystemPromptSections,
  joinSystemPrompt,
  withSystemPromptSections,
} from './systemPromptType.js'

describe('system prompt section metadata', () => {
  test('preserves named null slots without changing array or JSON output', () => {
    const prompt = withSystemPromptSections([
      { name: 'identity', text: 'identity text' },
      { name: 'optional', text: null },
      { text: 'boundary' },
    ])

    expect([...prompt]).toEqual(['identity text', 'boundary'])
    expect(JSON.stringify(prompt)).toBe('["identity text","boundary"]')
    expect(Object.keys(prompt)).toEqual(['0', '1'])
    expect(Object.getOwnPropertySymbols(prompt)).toHaveLength(1)
    expect(
      Object.getOwnPropertyDescriptor(
        prompt,
        Object.getOwnPropertySymbols(prompt)[0]!,
      )?.enumerable,
    ).toBe(false)
    expect(getSystemPromptSections(prompt)).toEqual([
      { name: 'identity', text: 'identity text' },
      { name: 'optional', text: null },
      { text: 'boundary' },
    ])
  })

  test('concatenates structured and literal prompts in byte order', () => {
    const base = withSystemPromptSections([
      { name: 'first', text: 'one' },
      { name: 'missing', text: null },
      { text: 'boundary' },
      { name: 'last', text: 'two' },
    ])
    const appended = asSystemPrompt(['append one', 'append two'])
    const prompt = concatSystemPrompts(base, appended)

    expect([...prompt]).toEqual([
      'one',
      'boundary',
      'two',
      'append one',
      'append two',
    ])
    expect(getSystemPromptSections(prompt)).toEqual([
      { name: 'first', text: 'one' },
      { name: 'missing', text: null },
      { text: 'boundary' },
      { name: 'last', text: 'two' },
      { text: 'append one' },
      { text: 'append two' },
    ])
  })

  test('retains joined block boundaries through later literal enhancement', () => {
    const base = withSystemPromptSections([
      { name: 'identity', text: 'one' },
      { name: 'missing', text: null },
      { text: 'two' },
    ])
    const joined = joinSystemPrompt(base, '\n')
    expect([...joined]).toEqual(['one\ntwo'])
    expect(getSystemPromptSections(joined)).toEqual([
      { sections: getSystemPromptSections(base), separator: '\n' },
    ])
    const enhanced = concatSystemPrompts(joined, ['Notes'])
    expect([...enhanced]).toEqual(['one\ntwo', 'Notes'])
    expect(getSystemPromptSections(enhanced)?.[1]).toEqual({ text: 'Notes' })
    const custom = joinSystemPrompt(['opaque', 'append'], '\n')
    expect([...custom]).toEqual(['opaque\nappend'])
    expect(getSystemPromptSections(custom)).toBeUndefined()
  })

  test('asSystemPrompt preserves existing metadata', () => {
    const prompt = withSystemPromptSections([{ name: 'identity', text: 'text' }])

    expect(asSystemPrompt(prompt)).toBe(prompt)
    expect(getSystemPromptSections(asSystemPrompt(prompt))).toEqual([
      { name: 'identity', text: 'text' },
    ])
  })

  test('leaves unstructured concatenation without a section plan', () => {
    const prompt = concatSystemPrompts(['custom'], ['append'])

    expect([...prompt]).toEqual(['custom', 'append'])
    expect(getSystemPromptSections(prompt)).toBeUndefined()
  })
})
