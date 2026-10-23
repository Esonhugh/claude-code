// AgentTool sends the workflow script runtime's relayed user request (ToolUseContext
// .workflowAgentRelayPrompt) as the user turn before the computed prompt, like official's
// workflow subagent, and does not pass it on to the subagent's own tool context.
import { expect, mock, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createStore } from '../../state/store.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

const childFlag = 'CLAUDE_CODE_WORKFLOW_AGENT_RELAY_PROMPT_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('workflow relay prompt through the real Agent lifecycle', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-workflow-relay-')))
    const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config'), XDG_CONFIG_HOME: join(directory, 'xdg'), XDG_CACHE_HOME: join(directory, 'cache'), TMPDIR: directory, ANTHROPIC_API_KEY: 'workflow-relay-dummy', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', [childFlag]: '1' },
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
      id: 'msg_workflow_relay', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: 'standard', cache_creation: null },
    } }
  },
}))
const { AgentTool } = await import('./AgentTool.js')
const { createAssistantMessage, createUserMessage } = await import('../../utils/messages.js')
const parent = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_parent', name: 'Agent', input: {}, caller: { type: 'direct' } }] })

function setup(workflowAgentRelayPrompt: string | undefined) {
  const state = getDefaultAppState()
  const store = createStore({ ...state, toolPermissionContext: getEmptyToolPermissionContext(), mcp: { ...state.mcp, clients: [], tools: [] } })
  return {
    options: { commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6', tools: [], verbose: false, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [GENERAL_PURPOSE_AGENT], inactiveAgents: [], allowedAgentTypes: undefined } },
    agentId: 'aworkflow', messages: [createUserMessage({ content: 'HISTORY' })], abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: store.getState, setAppState: store.setState,
    setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
    workflowAgentRelayPrompt,
  } as unknown as ToolUseContext
}

async function run(workflowAgentRelayPrompt: string | undefined) {
  const context = setup(workflowAgentRelayPrompt)
  await AgentTool.call({ prompt: '[computed] finish', description: 'relay probe', subagent_type: 'general-purpose', run_in_background: false }, context, async () => ({ behavior: 'allow' as const }), parent)
  const params = observedParams.pop()!
  const promptMessages = params.promptMessages as Message[]
  const childContext = params.toolUseContext as ToolUseContext
  return {
    turns: promptMessages.map(message => ({ type: message.type, content: (message as { message: { content: unknown } }).message.content })),
    childContext,
  }
}

test('no relay sends the prompt as the only user turn', async () => {
  const { turns } = await run(undefined)
  expect(turns).toEqual([{ type: 'user', content: '[computed] finish' }])
})

test('a relay prompt becomes the user turn before the computed prompt', async () => {
  const { turns, childContext } = await run('[relay] user asked')
  expect(turns).toEqual([
    { type: 'user', content: '[relay] user asked' },
    { type: 'user', content: '[computed] finish' },
  ])
  expect(childContext.workflowAgentRelayPrompt).toBeUndefined()
})
}
