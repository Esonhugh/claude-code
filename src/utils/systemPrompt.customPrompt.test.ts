import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ToolUseContext } from '../Tool.js'
import {
  getSystemPromptSections,
  withSystemPromptSections,
} from './systemPromptType.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= {
  VERSION: 'test',
  ISSUES_EXPLAINER: 'report an issue',
}

const { buildEffectiveSystemPrompt } = await import('./systemPrompt.js')
const toolUseContext = { options: {} } as Pick<ToolUseContext, 'options'>

describe('interactive custom system prompt characterization', () => {
  test('currently treats an empty custom prompt as absent', () => {
    const source = readFileSync(new URL('./systemPrompt.ts', import.meta.url), 'utf8')

    expect(source).toContain('customSystemPrompt\n        ? [customSystemPrompt]\n        : defaultSystemPrompt')
  })

  test('preserves default slots and records append text as a literal', () => {
    const defaultSystemPrompt = withSystemPromptSections([
      { name: 'identity', text: 'identity text' },
      { name: 'optional', text: null },
    ])

    const prompt = buildEffectiveSystemPrompt({
      mainThreadAgentDefinition: undefined,
      toolUseContext,
      customSystemPrompt: undefined,
      defaultSystemPrompt,
      appendSystemPrompt: 'append text',
    })

    expect([...prompt]).toEqual(['identity text', 'append text'])
    expect(getSystemPromptSections(prompt)).toEqual([
      { name: 'identity', text: 'identity text' },
      { name: 'optional', text: null },
      { text: 'append text' },
    ])
  })

  test('custom replacement has no inherited section plan', () => {
    const prompt = buildEffectiveSystemPrompt({
      mainThreadAgentDefinition: undefined,
      toolUseContext,
      customSystemPrompt: 'custom text',
      defaultSystemPrompt: withSystemPromptSections([
        { name: 'identity', text: 'identity text' },
      ]),
      appendSystemPrompt: undefined,
    })

    expect([...prompt]).toEqual(['custom text'])
    expect(getSystemPromptSections(prompt)).toBeUndefined()
  })
})
