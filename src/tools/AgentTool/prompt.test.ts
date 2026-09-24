import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from '../../services/mods/runtime.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  resolveModToolDescriptions,
  toolsToAPISchemas,
  toolToAPISchema,
} from '../../utils/api.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { AgentTool } from './AgentTool.js'
import { getPrompt } from './prompt.js'
import type { AgentDefinition } from './loadAgentsDir.js'

const agent = {
  agentType: 'reviewer',
  whenToUse: 'Use for focused code review.',
  tools: ['Read', 'Grep'],
} as AgentDefinition

describe('AgentTool prompt', () => {
  test('defaults the dynamic agent list to conversation attachments', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    const previousListInMessages =
      process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    process.env.ANTHROPIC_API_KEY = 'test-key'
    delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES

    let prompt: string
    try {
      prompt = await getPrompt([agent])
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
      if (previousListInMessages === undefined)
        delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
      else
        process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = previousListInMessages
    }

    expect(prompt).toContain(
      'Available agent types are listed in <system-reminder> messages',
    )
    expect(prompt).not.toContain('reviewer: Use for focused code review.')
    expect(prompt).toContain('starts fresh')
    expect(prompt).toContain('Before creating an agent, self-check')
    expect(prompt).toContain('Do not create an agent that duplicates work')
    expect(prompt).toContain('Prefer resuming an existing agent')
    expect(prompt).toContain('what you expect it to return')
    expect(prompt).toContain('run_in_background')
    expect(prompt).toContain('do not poll')
    expect(prompt).toContain('single message with multiple Agent tool calls')
    expect(prompt).toContain('result is not visible to the user')
    expect(prompt).toContain('SendMessage')
    expect(prompt).toContain('research or edit')
    expect(prompt).toContain('isolation: "worktree"')
    expect(prompt).not.toContain('greeting-responder')
    expect(prompt).not.toContain('checks if a number is prime')
    expect(prompt.length).toBeLessThan(2_800)
  })

  test('supports explicitly restoring the inline agent list', async () => {
    const previous = process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    process.env.ANTHROPIC_API_KEY = 'test-key'

    try {
      const prompt = await getPrompt([agent])
      expect(prompt).toContain('reviewer: Use for focused code review.')
      expect(prompt).not.toContain(
        'Available agent types are listed in <system-reminder> messages',
      )
    } finally {
      if (previous === undefined)
        delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
      else process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = previous
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
    }
  })

  test('projects each inline schema request against its captured generation', async () => {
    const previous = process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    process.env.ANTHROPIC_API_KEY = 'test-key'
    clearToolSchemaCache()
    const inputs: unknown[] = []
    const schema = (isOffered: boolean) => ({
      hasHooks: (event: string) => event === 'agent.offer',
      release() {},
      dispatch: async (_event: string, input: unknown) => {
        inputs.push(input)
        return { isOffered }
      },
    })
    const options = {
      tools: [AgentTool],
      agents: [agent],
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    }
    try {
      const first = await toolToAPISchema(AgentTool, {
        ...options,
        modsSnapshot: schema(false) as never,
      })
      const second = await toolToAPISchema(AgentTool, {
        ...options,
        modsSnapshot: schema(true) as never,
      })
      expect('description' in first ? first.description : '').not.toContain(
        'reviewer: Use for focused code review.',
      )
      expect('description' in second ? second.description : '').toContain(
        'reviewer: Use for focused code review.',
      )
      expect(inputs).toHaveLength(2)
    } finally {
      clearToolSchemaCache()
      if (previous === undefined)
        delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
      else process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = previous
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
    }
  })

  test('describes the listing projected by the current agent.offer generation', async () => {
    const previous = process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    process.env.ANTHROPIC_API_KEY = 'test-key'
    clearToolSchemaCache()
    const describeInputs: string[] = []
    const snapshot = {
      hasHooks: (event: string) =>
        event === 'agent.offer' || event === 'tool.describe',
      release() {},
      dispatch: async (event: string, input: Record<string, unknown>) => {
        if (event === 'agent.offer') return { isOffered: false }
        describeInputs.push(input.description as string)
        return { description: `${input.description}\nDESCRIBED` }
      },
    }
    const options = {
      tools: [AgentTool],
      agents: [agent],
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      modsSnapshot: snapshot as never,
    }
    try {
      const modDescriptions = await resolveModToolDescriptions(
        [AgentTool],
        options,
      )
      const projected = await toolsToAPISchemas([AgentTool], {
        ...options,
        modDescriptions,
      })
      const schema = projected.schemas[0]
      const description = schema && 'description' in schema ? schema.description : ''
      expect(describeInputs).toHaveLength(1)
      expect(describeInputs[0]).not.toContain(
        'reviewer: Use for focused code review.',
      )
      expect(description).not.toContain(
        'reviewer: Use for focused code review.',
      )
      expect(description).toEndWith('DESCRIBED')
    } finally {
      clearToolSchemaCache()
      if (previous === undefined)
        delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
      else process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = previous
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
    }
  })

  test('projects inline listings through agent.offer with pinned providers', async () => {
    const previous = process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    const root = await mkdtemp(join(tmpdir(), 'agent-offer-prompt-'))
    const runtime = createModsRuntime({
      services: {
        pluginOrigin: storageId =>
          storageId === 'pack@market'
            ? { plugin: storageId, tier: 'append' }
            : undefined,
      },
    })
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    process.env.ANTHROPIC_API_KEY = 'test-key'
    try {
      await writeFile(
        join(root, 'register.ts'),
        `export function register(on) {
          on('agent.offer', ($, e, next) => {
            if (e.agent === 'reviewer') return {isOffered:false};
            if (e.agent === 'pack:runner' && e.provider.plugin !== 'pack@market') throw Error('bad provider');
            return next(e);
          });
        }`,
      )
      await runtime.reconcile([
        {
          name: 'filter',
          storageId: 'filter@inline',
          pluginRoot: root,
          entrypoints: [join(root, 'register.ts')],
        },
      ])
      const snapshot = runtime.capture()
      try {
        const pluginAgent = {
          ...agent,
          agentType: 'pack:runner',
          source: 'plugin',
          plugin: 'pack@market',
        } as AgentDefinition
        const prompt = await getPrompt([agent, pluginAgent], undefined, undefined, {
          snapshot,
          signal: new AbortController().signal,
        })
        expect(prompt).not.toContain('reviewer: Use for focused code review.')
        expect(prompt).toContain('pack:runner: Use for focused code review.')
      } finally {
        snapshot.release()
      }
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
      if (previous === undefined)
        delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
      else process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = previous
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
    }
  })
})
