// AgentTool applies the workflow script runtime's per-spawn tool policy (ToolUseContext
// .workflowAgentToolPolicy): disallowedTools narrow the worker pool, bashCommandClamp
// denies Bash commands outside the clamp, and the policy is not passed on to the child.
import { expect, mock, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../Tool.js'
import { createStore } from '../../state/store.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

const childFlag = 'CLAUDE_CODE_WORKFLOW_AGENT_TOOL_POLICY_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('workflow tool policy through the real Agent lifecycle', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-workflow-policy-')))
    const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config'), XDG_CONFIG_HOME: join(directory, 'xdg'), XDG_CACHE_HOME: join(directory, 'cache'), TMPDIR: directory, ANTHROPIC_API_KEY: 'workflow-policy-dummy', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', [childFlag]: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    try {
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(exitCode, stdout + stderr).toBe(0)
      expect(stderr).toContain('0 fail')
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited }
      await rm(directory, { recursive: true, force: true })
    }
  })
} else {
const { setIsInteractive } = await import('../../bootstrap/state.js')
setIsInteractive(false)
const observedParams: Record<string, unknown>[] = []
mock.module('./runAgent.js', () => ({
  async *runAgent(params: Record<string, unknown>) {
    observedParams.push(params)
    yield { type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: {
      id: 'msg_workflow_policy', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: 'standard', cache_creation: null },
    } }
  },
}))
const { AgentTool } = await import('./AgentTool.js')
const { createAssistantMessage, createUserMessage } = await import('../../utils/messages.js')
const parent = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_parent', name: 'Agent', input: {}, caller: { type: 'direct' } }] })

function setup(workflowAgentToolPolicy: ToolUseContext['workflowAgentToolPolicy']) {
  const state = getDefaultAppState()
  const store = createStore({ ...state, toolPermissionContext: getEmptyToolPermissionContext(), mcp: { ...state.mcp, clients: [], tools: [] } })
  return {
    options: { commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6', tools: [], verbose: false, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [GENERAL_PURPOSE_AGENT], inactiveAgents: [], allowedAgentTypes: undefined } },
    agentId: 'aworkflow', messages: [createUserMessage({ content: 'HISTORY' })], abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: store.getState, setAppState: store.setState,
    setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
    workflowAgentToolPolicy,
  } as unknown as ToolUseContext
}

async function run(workflowAgentToolPolicy: ToolUseContext['workflowAgentToolPolicy']) {
  const context = setup(workflowAgentToolPolicy)
  await AgentTool.call({ prompt: 'finish', description: 'policy probe', subagent_type: 'general-purpose', run_in_background: false }, context, async () => ({ behavior: 'allow' as const }), parent)
  const params = observedParams.pop()!
  const definition = params.agentDefinition as { disallowedTools?: string[] }
  const availableTools = params.availableTools as Tool[]
  const childContext = params.toolUseContext as ToolUseContext
  return { definition, availableTools, childContext, context }
}

test('no policy leaves the agent definition and worker pool alone', async () => {
  const { definition, availableTools } = await run(undefined)
  expect(definition.disallowedTools).toBeUndefined()
  expect(availableTools.some(tool => tool.name === 'Bash')).toBe(true)
  expect(availableTools.some(tool => tool.name === 'Write')).toBe(true)
})

test('disallowedTools are merged into the selected agent definition', async () => {
  const { definition, childContext } = await run({ disallowedTools: ['Write', 'Edit'] })
  expect(definition.disallowedTools).toEqual(['Write', 'Edit'])
  expect(childContext.workflowAgentToolPolicy).toBeUndefined()
})

test('bashCommandClamp withholds MCP/ToolSearch and denies commands outside the clamp', async () => {
  const { definition, availableTools, context } = await run({ bashCommandClamp: ['Bash(git status:*)'] })
  expect(definition.disallowedTools).toEqual(['mcp__*', 'ToolSearch'])
  const bash = availableTools.find(tool => tool.name === 'Bash')!
  const allowed = await bash.checkPermissions({ command: 'git status --short' } as never, context)
  expect(allowed.behavior).not.toBe('deny')
  const denied = await bash.checkPermissions({ command: 'git push' } as never, context)
  expect(denied.behavior).toBe('deny')
  expect((denied as { decisionReason?: unknown }).decisionReason).toEqual({ type: 'other', reason: 'workflow agent() bashCommandClamp' })
})

test('a clamp on a Bash-less agent refuses the spawn', async () => {
  await expect(run({ disallowedTools: ['Bash'], bashCommandClamp: ['Bash(git status:*)'] })).rejects.toThrow(
    /agent\(\) opts\.bashCommandClamp can bind nothing: the spawned agent's resolved tool pool has no Bash/,
  )
})
}
