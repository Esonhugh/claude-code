import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'src/commands.js'
import { clearCommandsCache } from 'src/commands.js'
import {
  clearInvokedSkills,
  getInvokedSkillsForAgent,
  getIsInteractive,
  getProjectRoot,
  setIsInteractive,
  setProjectRoot,
} from 'src/bootstrap/state.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import type { ToolUseContext } from 'src/Tool.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { createModsRuntime } from '../../services/mods/runtime.js'
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

  test('routes model-invoked skills through skill.prompt', async () => {
    const originalProjectRoot = getProjectRoot()
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    const originalDisableAttachments = process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
    const root = await mkdtemp(join(tmpdir(), 'skill-tool-prompt-'))
    const skillDir = join(root, '.claude', 'skills', 'rewrite-skill')
    const modDir = join(root, 'mod')
    const entry = join(modDir, 'register.ts')
    const runtime = createModsRuntime()
    try {
      process.env.ANTHROPIC_API_KEY = 'test'
      process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
      await mkdir(skillDir, { recursive: true })
      await mkdir(modDir, { recursive: true })
      await writeFile(
        join(skillDir, 'SKILL.md'),
        '---\nname: rewrite-skill\ndescription: rewrite the prompt\n---\nOriginal skill body',
      )
      await writeFile(
        entry,
        `export function register(on) {
          on('skill.prompt', { skill: 'rewrite-skill' }, async ($, e, next) => {
            const core = await next(e);
            return { text: core.text + '\\n\\nRewritten by Skill tool' };
          });
        }`,
      )
      await runtime.reconcile([
        {
          name: 'rewrite-skill',
          storageId: 'rewrite-skill@tool-test',
          pluginRoot: modDir,
          entrypoints: [entry],
        },
      ])
      setProjectRoot(root)
      clearCommandsCache()
      clearInvokedSkills()

      const appState = getDefaultAppState()
      const context = {
        options: {
          commands: [],
          debug: false,
          mainLoopModel: 'claude-sonnet-4-6',
          tools: [],
          verbose: false,
          thinkingConfig: { type: 'disabled' },
          mcpClients: [],
          mcpResources: {},
          isNonInteractiveSession: false,
          agentDefinitions: {
            activeAgents: [],
            allAgents: [],
            allowedAgentTypes: undefined,
          },
        },
        abortController: new AbortController(),
        readFileState: createFileStateCacheWithSizeLimit(10),
        getAppState: () => appState,
        setAppState: () => {},
        setInProgressToolUseIDs: () => {},
        setResponseLength: () => {},
        updateFileHistoryState: () => {},
        updateAttributionState: () => {},
        messages: [],
        mods: runtime,
      } as ToolUseContext
      const result = await SkillTool.call(
        { skill: 'rewrite-skill' },
        context,
        async input => ({ behavior: 'allow', updatedInput: input }),
        { type: 'assistant', message: { content: [] } } as never,
      )

      expect(JSON.stringify(result.newMessages)).toContain(
        'Rewritten by Skill tool',
      )
      expect(
        getInvokedSkillsForAgent(null).get(':rewrite-skill')?.content,
      ).toContain('Rewritten by Skill tool')
    } finally {
      clearInvokedSkills()
      setProjectRoot(originalProjectRoot)
      clearCommandsCache()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = originalApiKey
      if (originalDisableAttachments === undefined)
        delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
      else
        process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = originalDisableAttachments
    }
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
