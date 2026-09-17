import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import {
  isModEventPattern,
  matchesModEventPattern,
  matchesModMatcher,
  normalizeModMatcher,
} from './matcher'

test('normalizes literal, RegExp, any-of, and nested partial matcher data', () => {
  const normalized = normalizeModMatcher({
    tool: ['Bash', /^Edit$/i],
    input: { command: /^git\s/, flags: [null, true, -1] },
  })

  expect(matchesModMatcher(normalized, {
    tool: 'edit',
    input: { command: 'git status', flags: true, ignored: true },
  })).toBe(true)
  expect(matchesModMatcher(normalized, {
    tool: 'Read',
    input: { command: 'git status', flags: true },
  })).toBe(false)
  expect(matchesModMatcher(normalizeModMatcher({ tool: 'Edit' }), {
    tool: ['Read', 'Edit'],
  })).toBe(true)
  expect(matchesModMatcher(normalized, {
    tool: 'Bash',
    input: { command: 'pwd', flags: true },
  })).toBe(false)
})

test('pure exports can be installed in the isolated VM from source text', () => {
  const vmNormalize = runInNewContext(`(${normalizeModMatcher.toString()})`, {
    Set,
    Object,
    Array,
    Number,
    RegExp,
    Error,
    Reflect,
  }) as typeof normalizeModMatcher
  const vmMatches = runInNewContext(`(${matchesModMatcher.toString()})`, {
    Array,
    Object,
    RegExp,
    String,
  }) as typeof matchesModMatcher
  const normalized = vmNormalize({ input: { command: /^git/ } })
  expect(vmMatches(normalized, { input: { command: 'git status' } })).toBe(true)
})

test('matches exact, global, noun glob, and negated event patterns', () => {
  for (const pattern of ['tool.call', '*', 'tool.*', '!tool.call', '!tool.*']) {
    expect(isModEventPattern(pattern)).toBe(true)
  }
  expect(matchesModEventPattern('tool.call', 'tool.call')).toBe(true)
  expect(matchesModEventPattern('*', 'tool.call')).toBe(true)
  expect(matchesModEventPattern('tool.*', 'tool.call')).toBe(true)
  expect(matchesModEventPattern('!tool.call', 'session.start')).toBe(true)
  expect(matchesModEventPattern('!tool.*', 'tool.call')).toBe(false)
  expect(isModEventPattern('tool.c*')).toBe(false)
  expect(isModEventPattern('!!tool.call')).toBe(false)
})

test('rejects accessors, reserved keys, cycles, and non-data values', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const accessor = Object.create(null, {
    tool: { enumerable: true, get: () => 'Bash' },
  })
  const reserved = Object.fromEntries([['__proto__', 'x']])

  for (const matcher of [accessor, reserved, { constructor: 'x' }, cyclic, { tool: () => true }]) {
    expect(() => normalizeModMatcher(matcher)).toThrow(/matcher/i)
  }
})
