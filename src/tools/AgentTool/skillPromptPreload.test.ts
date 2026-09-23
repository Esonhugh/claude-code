import { expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childEnv = 'CLAUDE_CODE_AGENT_SKILL_PROMPT_TEST_CHILD'

if (process.env[childEnv] === '1') {
  await runIsolatedPreloadTest()
} else {
  test('preloads rewritten skill text into an agent query', async () => {
    const child = Bun.spawn(
      [process.execPath, 'test', '--timeout', '30000', import.meta.path],
      {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: 'test-key',
          [childEnv]: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 60_000,
      },
    )
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(`${stdout}\n${stderr}`).toContain(
        'agent skill.prompt preload passed',
      )
      expect(exitCode).toBe(0)
    } finally {
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
    }
  }, 65_000)
}

async function runIsolatedPreloadTest(): Promise<void> {
  let queryMessages: unknown[] = []
  mock.module('../../query.js', () => ({
    query: async function* (params: { messages: unknown[] }) {
      queryMessages = [...params.messages]
      return { reason: 'completed' }
    },
  }))

  const {
    clearInvokedSkills,
    getInvokedSkillsForAgent,
  } = await import('../../bootstrap/state.js')
  const { clearCommandsCache } = await import('../../commands.js')
  const {
    clearBundledSkills,
    registerBundledSkill,
  } = await import('../../skills/bundledSkills.js')
  const { createModsRuntime } = await import('../../services/mods/runtime.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../../utils/fileStateCache.js')
  const { createUserMessage } = await import('../../utils/messages.js')
  const { GENERAL_PURPOSE_AGENT } = await import('./built-in/generalPurposeAgent.js')
  const { runAgent } = await import('./runAgent.js')

  const root = await mkdtemp(join(tmpdir(), 'agent-skill-prompt-'))
  const entry = join(root, 'register.ts')
  const runtime = createModsRuntime()
  try {
    await writeFile(
      entry,
      `export function register(on) {
        on('skill.prompt', { skill: 'preloaded-skill' }, async ($, e, next) => {
          const core = await next(e);
          return { text: core.text + '\\n\\nRewritten for preload' };
        });
      }`,
    )
    await runtime.reconcile([
      {
        name: 'preload',
        storageId: 'preload@agent-test',
        pluginRoot: root,
        entrypoints: [entry],
      },
    ])

    clearBundledSkills()
    clearCommandsCache()
    registerBundledSkill({
      name: 'preloaded-skill',
      description: 'preload this skill',
      async getPromptForCommand() {
        return [{ type: 'text', text: 'Original preload body' }]
      },
    })
    const appState = getDefaultAppState()
    const agentDefinition = {
      ...GENERAL_PURPOSE_AGENT,
      skills: ['preloaded-skill'],
    }
    const agentId = 'agent-skill-prompt-test' as never
    const toolUseContext = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'claude-sonnet-4-6',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' as const },
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
    } as never

    clearInvokedSkills()
    const iterator = runAgent({
      agentDefinition,
      promptMessages: [createUserMessage({ content: 'finish the task' })],
      toolUseContext,
      canUseTool: async input => ({ behavior: 'allow', updatedInput: input }),
      isAsync: false,
      querySource: 'agent:test',
      availableTools: [],
      override: { agentId, userContext: {}, systemContext: {} },
    })
    for (;;) {
      if ((await iterator.next()).done) break
    }

    const serialized = JSON.stringify(queryMessages)
    expect(serialized).toContain('Original preload body')
    expect(serialized).toContain('Rewritten for preload')
    expect(
      getInvokedSkillsForAgent(agentId).get(`${agentId}:preloaded-skill`)?.content,
    ).toContain('Rewritten for preload')
    console.log('agent skill.prompt preload passed')
  } finally {
    clearInvokedSkills()
    clearBundledSkills()
    clearCommandsCache()
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
}
