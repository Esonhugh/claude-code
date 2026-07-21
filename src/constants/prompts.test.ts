import { describe, expect, test } from 'bun:test'
import { getUsingYourToolsSection } from './prompts.js'

describe('getUsingYourToolsSection', () => {
  test('keeps dedicated-tool and task lifecycle rules without duplicating command-by-command guidance', () => {
    const prompt = getUsingYourToolsSection(
      new Set(['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TaskCreate']),
    )

    expect(prompt).toContain('Prefer dedicated tools over Bash when one fits')
    expect(prompt).toContain('reserve Bash for shell-only operations')
    expect(prompt).toContain('Mark each task completed as soon as')
    expect(prompt).toContain('independent tool calls in parallel')
    expect(prompt).not.toContain('instead of cat, head, tail, or sed')
    expect(prompt.length).toBeLessThan(1_300)
  })
})
