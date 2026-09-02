import { describe, expect, test } from 'bun:test'
import type { Command } from 'src/commands.js'
import { getIsInteractive, setIsInteractive } from 'src/bootstrap/state.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import type { ToolUseContext } from 'src/Tool.js'
import { SkillTool } from './SkillTool.js'
import { formatCommandsWithinBudget, getPrompt } from './prompt.js'

function command(name: string): Command {
  return {
    type: 'prompt',
    name,
    description: `${name} description`,
    source: 'bundled',
  } as Command
}

describe('SkillTool prompt', () => {
  test('formats the same skill set deterministically', () => {
    const forward = [command('zeta'), command('alpha'), command('middle')]
    const reverse = [...forward].reverse()

    expect(formatCommandsWithinBudget(forward)).toBe(
      formatCommandsWithinBudget(reverse),
    )
  })

  test('keeps invocation boundaries without tutorial examples', async () => {
    const prompt = await getPrompt('/tmp')

    expect(prompt).toContain('Invoke a skill.')
    expect(prompt).toContain('exact name from the listing')
    expect(prompt).toContain('Plugin skills use `plugin:skill`')
    expect(prompt).toContain('`<server>:<uri>`')
    expect(prompt).toContain('`docs:skill://pdf/SKILL.md`')
    expect(prompt).toContain('explicitly supplied by the user or server instructions')
    expect(prompt).toContain('call this tool first')
    expect(prompt).toContain('Built-in CLI commands')
    expect(prompt).toContain('<command-name>')
    expect(prompt).not.toContain('- Examples:')
    expect(prompt.length).toBeLessThan(1_100)
  })

  test('rejects model invocation of the non-interactive goal command', async () => {
    const wasInteractive = getIsInteractive()
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    setIsInteractive(false)
    process.env.ANTHROPIC_API_KEY = 'test'
    try {
      const appState = getDefaultAppState()
      const context = {
        getAppState: () => appState,
      } as ToolUseContext

      const result = await SkillTool.validateInput({ skill: 'goal' }, context)
      expect(result).toEqual({
        result: false,
        message:
          'Skill goal cannot be used with Skill tool due to disable-model-invocation',
        errorCode: 4,
      })
    } finally {
      setIsInteractive(wasInteractive)
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = originalApiKey
    }
  })
})
