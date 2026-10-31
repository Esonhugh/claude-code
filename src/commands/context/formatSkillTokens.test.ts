import { expect, test } from 'bun:test'
import { formatSkillTokens } from './context-noninteractive.js'

test('skill token estimates are rounded and marked approximate like 2.1.311', () => {
  expect(formatSkillTokens(481)).toBe('~480')
  expect(formatSkillTokens(113)).toBe('~110')
  expect(formatSkillTokens(19)).toBe('< 20')
  expect(formatSkillTokens(2150)).toBe('~2.2k')
})
