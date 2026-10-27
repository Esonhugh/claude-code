import { afterEach, expect, test } from 'bun:test'
import {
  applyThinkingRequest,
  shouldOmitThinkingByDefault,
  type ThinkingConfig,
} from './thinking.js'

const original = process.env.MAX_THINKING_TOKENS
afterEach(() => {
  if (original === undefined) delete process.env.MAX_THINKING_TOKENS
  else process.env.MAX_THINKING_TOKENS = original
})

const spawn: ThinkingConfig = { type: 'adaptive', display: 'omitted' }

test('display-only request keeps the current budget', () => {
  const current: ThinkingConfig = { type: 'enabled', budgetTokens: 5000 }
  expect(applyThinkingRequest(current, spawn, undefined, 'summarized')).toEqual({
    type: 'enabled',
    budgetTokens: 5000,
    display: 'summarized',
  })
})

test('a budget carries the session display', () => {
  expect(applyThinkingRequest(spawn, spawn, 5000, 'summarized')).toEqual({
    type: 'enabled',
    budgetTokens: 5000,
    display: 'summarized',
  })
  expect(applyThinkingRequest(spawn, spawn, 0, 'summarized')).toEqual({ type: 'disabled' })
})

test('null budget resets to the spawn-time config with the session display', () => {
  const current: ThinkingConfig = { type: 'enabled', budgetTokens: 5000 }
  expect(applyThinkingRequest(current, spawn, null, undefined)).toEqual({
    type: 'adaptive',
    display: undefined,
  })
  expect(applyThinkingRequest(current, { type: 'disabled' }, null, 'summarized')).toEqual({
    type: 'disabled',
  })
})

test('display-only request leaves disabled thinking off', () => {
  expect(applyThinkingRequest({ type: 'disabled' }, spawn, undefined, 'summarized')).toEqual({
    type: 'disabled',
  })
})

test('without any config a display turns on default thinking', () => {
  delete process.env.MAX_THINKING_TOKENS
  expect(applyThinkingRequest(undefined, undefined, undefined, 'summarized')).toEqual({
    type: 'adaptive',
    display: 'summarized',
  })
  expect(applyThinkingRequest(undefined, undefined, null, undefined)).toBeUndefined()
})

test('-p text and non-verbose json omit thinking by default', () => {
  expect(shouldOmitThinkingByDefault(undefined, false)).toBe(true)
  expect(shouldOmitThinkingByDefault('text', true)).toBe(true)
  expect(shouldOmitThinkingByDefault('json', false)).toBe(true)
  expect(shouldOmitThinkingByDefault('json', true)).toBe(false)
  expect(shouldOmitThinkingByDefault('stream-json', true)).toBe(false)
})
