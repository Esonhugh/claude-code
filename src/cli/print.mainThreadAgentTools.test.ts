import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '../Tool.js'

const childFlag = 'CLAUDE_CODE_MAIN_THREAD_AGENT_TOOLS_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('-p --agent applies the agent tool list (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-main-agent-tools-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_TEST_FIXTURES_ROOT: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { runHeadless } = await import('./print.js')
  const { StructuredIO } = await import('./structuredIO.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const { createStore } = await import('../state/store.js')
  const { onChangeAppState } = await import('../state/onChangeAppState.js')
  const bootstrap = await import('../bootstrap/state.js')
  const grove = await import('../services/api/grove.js')
  const growthbook = await import('../services/analytics/growthbook.js')
  const env = await import('../utils/envUtils.js')
  const shutdown = await import('../utils/gracefulShutdown.js')
  const processUtils = await import('../utils/process.js')
  const stdoutGuard = await import('../utils/streamJsonStdoutGuard.js')
  const modelStrings = await import('../utils/model/modelStrings.js')
  const toolPool = await import('../tools.js')
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')
  const engine = await import('../QueryEngine.js')
  const { createAssistantMessage } = await import('../utils/messages.js')
  const { parseAgentsFromJson } = await import('../tools/AgentTool/loadAgentsDir.js')
  const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
  const { BashTool } = await import('../tools/BashTool/BashTool.js')
  const { FileWriteTool } = await import('../tools/FileWriteTool/FileWriteTool.js')
  const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')

  async function run(agent: string | undefined, extraTools: Tool[] = []) {
    const store = createStore(getDefaultAppState(), onChangeAppState)
    const toolNames: string[][] = []
    const allowed: (string[] | undefined)[] = []
    const mocks = [
      spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env, 'isBareMode').mockReturnValue(true),
      spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
      spyOn(engine, 'ask').mockImplementation(async function* (options) {
        toolNames.push(options.tools.map(tool => tool.name).sort())
        allowed.push(options.allowedAgentTypes)
        const assistant = createAssistantMessage({ content: 'done' })
        yield { type: 'assistant', message: assistant.message, parent_tool_use_id: null,
          session_id: bootstrap.getSessionId(), uuid: assistant.uuid }
      }),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async () => {}),
    ]
    const agents = parseAgentsFromJson({
      ro: { description: 'read only', prompt: 'p', tools: ['Read'] },
      nobash: { description: 'no bash', prompt: 'p', disallowedTools: ['Bash'] },
      spawner: { description: 'spawner', prompt: 'p', tools: ['Agent(ro)', 'Read'] },
    }, 'flagSettings')
    bootstrap.setMainThreadAgentType(agent)
    async function* input() {
      yield JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n'
    }
    try {
      await runHeadless(input(), store.getState, store.setState, [], [FileReadTool, BashTool, FileWriteTool, ...extraTools], {}, agents, {
        outputFormat: 'stream-json', verbose: true, agent, sessionStartHooksPromise: Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
    } finally {
      for (const mock of mocks) mock.mockRestore()
      bootstrap.setMainThreadAgentType(undefined)
    }
    return { toolNames, allowed }
  }

  test('without --agent every tool is offered', async () => {
    expect(await run(undefined)).toEqual({ toolNames: [['Bash', 'Read', 'Write']], allowed: [undefined] })
  })

  test('--agent with a tools list keeps only those tools', async () => {
    expect(await run('ro')).toEqual({ toolNames: [['Read']], allowed: [undefined] })
  })

  test('--agent with Agent(type) limits the spawnable agent types', async () => {
    expect(await run('spawner', [AgentTool])).toEqual({ toolNames: [['Agent', 'Read']], allowed: [['ro']] })
  })

  test('--agent with disallowedTools drops those tools', async () => {
    expect(await run('nobash')).toEqual({ toolNames: [['Read', 'Write']], allowed: [undefined] })
  })
}
