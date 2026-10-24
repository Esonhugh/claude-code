import { expect, test } from 'bun:test'
import type { Command } from '../types/command.js'
import { getSkillOverride, isSkillHiddenFromModel, nextSkillOverride } from './skillOverrides.js'

const skill = (name: string, loadedFrom: string) => ({ type: 'prompt', name, loadedFrom }) as unknown as Command

test('reads the override for project and user skills, defaulting to on', () => {
  const overrides = { hello: 'name-only', bye: 'off' } as const
  expect(getSkillOverride(skill('hello', 'skills'), overrides)).toBe('name-only')
  expect(getSkillOverride(skill('bye', 'commands_DEPRECATED'), overrides)).toBe('off')
  expect(getSkillOverride(skill('other', 'skills'), overrides)).toBe('on')
})

test('plugin skills ignore per-skill overrides', () => {
  expect(getSkillOverride(skill('tools:lint', 'plugin'), { 'tools:lint': 'off' })).toBe('on')
})

test('off and user-invocable-only hide the skill from the model', () => {
  const overrides = { a: 'off', b: 'user-invocable-only', c: 'name-only' } as const
  expect(isSkillHiddenFromModel(skill('a', 'skills'), overrides)).toBe(true)
  expect(isSkillHiddenFromModel(skill('b', 'skills'), overrides)).toBe(true)
  expect(isSkillHiddenFromModel(skill('c', 'skills'), overrides)).toBe(false)
})

test('cycles in the official order', () => {
  expect(nextSkillOverride('on')).toBe('name-only')
  expect(nextSkillOverride('name-only')).toBe('user-invocable-only')
  expect(nextSkillOverride('user-invocable-only')).toBe('off')
  expect(nextSkillOverride('off')).toBe('on')
})
