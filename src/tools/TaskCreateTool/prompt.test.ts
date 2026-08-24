import { describe, expect, test } from 'bun:test'
import { getPrompt } from './prompt.js'

describe('TaskCreate prompt', () => {
  test('does not turn every new instruction into a task', () => {
    const prompt = getPrompt()

    expect(prompt).not.toContain(
      'After receiving new instructions - Immediately capture user requirements as tasks',
    )
    expect(prompt).toContain('single, straightforward task')
    expect(prompt).toContain('purely conversational or informational')
    expect(prompt).toContain('3 or more distinct steps or actions')
  })
})
