import { describe, expect, test } from 'bun:test'
import { getPrompt } from './prompt.js'

describe('SkillTool prompt', () => {
  test('keeps invocation boundaries without tutorial examples', async () => {
    const prompt = await getPrompt('/tmp')

    expect(prompt).toContain('Invoke a skill.')
    expect(prompt).toContain('exact name from the listing')
    expect(prompt).toContain('Plugin skills use `plugin:skill`')
    expect(prompt).toContain('call this tool first')
    expect(prompt).toContain('Built-in CLI commands')
    expect(prompt).toContain('<command-name>')
    expect(prompt).not.toContain('- Examples:')
    expect(prompt.length).toBeLessThan(1_100)
  })
})
