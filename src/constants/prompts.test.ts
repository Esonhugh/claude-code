import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import type { Tools } from '../Tool.js'
import { clearSystemPromptSections } from './systemPromptSections.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
  ISSUES_EXPLAINER: 'report an issue',
}

const { getSystemPrompt, getUsingYourToolsSection, getProactiveSection } =
  await import('./prompts.js')

const ORIGINAL_DISABLE_BETAS = process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY
const ORIGINAL_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI
const ORIGINAL_DISABLE_GIT = process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS

afterEach(() => {
  if (ORIGINAL_DISABLE_BETAS === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  } else {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = ORIGINAL_DISABLE_BETAS
  }
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY
  }
  if (ORIGINAL_USE_OPENAI === undefined) {
    delete process.env.CLAUDE_CODE_USE_OPENAI
  } else {
    process.env.CLAUDE_CODE_USE_OPENAI = ORIGINAL_USE_OPENAI
  }
  if (ORIGINAL_DISABLE_GIT === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
  } else {
    process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = ORIGINAL_DISABLE_GIT
  }
  clearSystemPromptSections()
})

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

  test('keeps minimal git safety in action guidance when enabled', async () => {
    process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = '0'
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    delete process.env.CLAUDE_CODE_USE_OPENAI
    process.env.ANTHROPIC_API_KEY = 'test-key'

    const prompt = (
      await getSystemPrompt(
        [{ name: 'Bash' }, { name: 'Read' }] as unknown as Tools,
        'claude-opus-4-6',
      )
    ).join('\n')

    expect(prompt).toContain(
      'For git operations, only commit, push, create a pull request',
    )
    expect(prompt).toContain('rewrite history, or change git configuration')
    expect(prompt).toContain('when the user explicitly authorizes that action')
    expect(prompt).toContain('Do not skip hooks or signing checks unless the user explicitly requests it')
    expect(prompt.split('Prefer dedicated tools over Bash').length - 1).toBe(1)
    expect(prompt.split('make all independent tool calls in parallel').length - 1).toBe(1)
    expect(prompt).not.toContain('# Git commits and pull requests')
    expect(prompt).not.toContain('For a commit:')
  })
})

describe('git instruction opt-out', () => {
  test('omits git-specific guidance but preserves general action authorization', async () => {
    process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = '1'
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    delete process.env.CLAUDE_CODE_USE_OPENAI
    process.env.ANTHROPIC_API_KEY = 'test-key'

    const prompt = (await getSystemPrompt(
      [{ name: 'Bash' }, { name: 'Read' }] as unknown as Tools,
      'claude-opus-4-6',
    )).join('\n')

    expect(prompt).not.toContain('For git operations, only commit')
    expect(prompt).toContain('Approval for one action does not authorize later actions')
    expect(prompt).toContain('Do not bypass safety checks')
  })
})

describe('getSystemPrompt layering', () => {
  test('places stable core and capability guidance before task-dynamic context', async () => {
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    delete process.env.CLAUDE_CODE_USE_OPENAI
    process.env.ANTHROPIC_API_KEY = 'test-key'

    const prompt = await getSystemPrompt(
      [
        { name: 'Bash' },
        { name: 'Read' },
      ] as unknown as Tools,
      'claude-opus-4-6',
    )

    const boundaryIndex = prompt.indexOf('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
    expect(boundaryIndex).toBeGreaterThan(0)
    expect(
      prompt.findIndex(section =>
        section.includes('identify the active constraints and material trade-offs'),
      ),
    ).toBeLessThan(boundaryIndex)
    expect(
      prompt.findIndex(section => section.includes('# Using your tools')),
    ).toBeLessThan(boundaryIndex)
    expect(
      prompt.findIndex(section => section.includes('# Environment')),
    ).toBeGreaterThan(boundaryIndex)
    const renderedPrompt = prompt.join('\n')
    expect(renderedPrompt).toContain('Scope controls to the threat model')
    expect(renderedPrompt).toContain(
      "Don't add defensive guards, error handling, fallbacks, or validation for impossible states",
    )
    expect(renderedPrompt).toContain(
      "Don't create one-off helpers or abstractions or design for hypothetical needs",
    )
    expect(new Set(prompt).size).toBe(prompt.length)
  })
})

describe('proactive prompt ownership', () => {
  test('reuses proactive instructions at each custom-prompt assembly boundary', () => {
    const mainSource = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
    const promptSource = readFileSync(
      new URL('./prompts.ts', import.meta.url),
      'utf8',
    )
    const interactiveSource = readFileSync(
      new URL('../utils/systemPrompt.ts', import.meta.url),
      'utf8',
    )
    const headlessSource = readFileSync(
      new URL('../QueryEngine.ts', import.meta.url),
      'utf8',
    )

    expect(mainSource).not.toContain('const proactivePrompt =')
    expect(mainSource).toContain('maybeActivateProactive(options)')
    expect(interactiveSource).toContain(
      'const proactiveInstructions = customSystemPrompt',
    )
    expect(headlessSource).toContain(
      'customPrompt !== undefined && !coordinatorModeModule?.isCoordinatorMode()',
    )
    expect(promptSource).toContain('export function getProactiveSection()')
    expect(promptSource).toContain(
      'Only commit, push, or create a PR when the user explicitly authorized that operation.',
    )
    expect(promptSource).not.toContain(
      'Commit when you reach a good stopping point.',
    )
    expect(promptSource).not.toContain(
      'Lean heavily into autonomous action — make decisions, explore, commit, push.',
    )
  })

  test('returns null when proactive is inactive', () => {
    expect(getProactiveSection()).toBeNull()
  })
})
