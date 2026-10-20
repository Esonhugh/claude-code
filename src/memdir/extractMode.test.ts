import { afterEach, expect, test } from 'bun:test'
import { setIsInteractive } from '../bootstrap/state.js'
import { isExtractModeActive } from './paths.js'

const envKey = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'
const savedEnv = process.env[envKey]

afterEach(() => {
  if (savedEnv === undefined) delete process.env[envKey]
  else process.env[envKey] = savedEnv
  setIsInteractive(true)
})

test('memory extraction runs in interactive sessions without a remote gate', () => {
  process.env[envKey] = '0'
  setIsInteractive(true)
  expect(isExtractModeActive()).toBe(true)
})

test('CLAUDE_CODE_DISABLE_AUTO_MEMORY turns memory extraction off', () => {
  process.env[envKey] = '1'
  setIsInteractive(true)
  expect(isExtractModeActive()).toBe(false)
})

test('non-interactive sessions keep extraction off by default', () => {
  process.env[envKey] = '0'
  setIsInteractive(false)
  expect(isExtractModeActive()).toBe(false)
})
