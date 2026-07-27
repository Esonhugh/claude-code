import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import { resetGitFileWatcher } from '../../utils/git/gitFilesystem.js'
import { createUserMessage } from '../../utils/messages.js'
import {
  flushSessionStorage,
  recordSidechainTranscript,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

let controlledPermissionMode: string | undefined
let controlledAllowedTools: string[] | undefined

mock.module('./runAgent.js', () => ({
  async *runAgent(params: {
    permissionMode?: string
    allowedTools?: string[]
  }) {
    controlledPermissionMode = params.permissionMode
    controlledAllowedTools = params.allowedTools
    yield {
      type: 'assistant',
      uuid: crypto.randomUUID(),
      requestId: 'req_resume_permission_mode',
      message: {
        id: 'msg_resume_permission_mode',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: 'standard',
          cache_creation: null,
        },
      },
    }
  },
}))

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const configDir = mkdtempSync(join(tmpdir(), 'resume-agent-permission-test-'))
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

const { resumeAgentBackground } = await import('./resumeAgent.js')

async function runCase({
  agentId,
  parentMode,
  metadataMode,
  definitionMode,
  definitionTools,
}: {
  agentId: string
  parentMode: 'default' | 'bypassPermissions'
  metadataMode?: 'default' | 'acceptEdits'
  definitionMode?: 'acceptEdits'
  definitionTools?: string[]
}) {
  const typedAgentId = asAgentId(agentId)
  await recordSidechainTranscript(
    [createUserMessage({ content: 'original prompt' })],
    agentId,
  )
  await flushSessionStorage()
  const usesDefinitionAgent = definitionMode !== undefined || definitionTools !== undefined
  await writeAgentMetadata(typedAgentId, {
    agentType: usesDefinitionAgent
      ? 'resume-definition-agent'
      : 'general-purpose',
    ...(metadataMode ? { permissionMode: metadataMode } : {}),
  })

  const definitionAgent = {
    ...GENERAL_PURPOSE_AGENT,
    agentType: 'resume-definition-agent',
    permissionMode: definitionMode,
    tools: definitionTools,
  }
  let state = {
    ...getDefaultAppState(),
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: parentMode,
    },
    mcp: {
      ...getDefaultAppState().mcp,
      tools: [],
      clients: [],
    },
    tasks: {},
    agentNameRegistry: new Map(),
  }
  let resolveCompletion: (() => void) | undefined
  const completion = new Promise<void>(resolve => {
    resolveCompletion = resolve
  })
  const setAppState = (
    updater: (prev: typeof state) => typeof state,
  ) => {
    state = updater(state)
    if (
      Object.values(state.tasks).some(
        task =>
          typeof task === 'object' &&
          task !== null &&
          'status' in task &&
          task.status === 'completed',
      )
    ) {
      resolveCompletion?.()
    }
  }
  controlledPermissionMode = undefined
  controlledAllowedTools = undefined

  await resumeAgentBackground({
    agentId,
    prompt: 'continue',
    toolUseContext: {
      options: {
        tools: [FileReadTool],
        mainLoopModel: 'claude-sonnet-4-6',
        mcpClients: [],
        agentDefinitions: {
          activeAgents: [GENERAL_PURPOSE_AGENT, definitionAgent],
          inactiveAgents: [],
          allowedAgentTypes: undefined,
        },
      },
      getAppState: () => state,
      setAppState,
      toolUseId: `toolu_${agentId}`,
      contentReplacementState: undefined,
    } as never,
    canUseTool: async () => ({ behavior: 'allow' }),
  })
  await completion

  return {
    permissionMode: controlledPermissionMode,
    allowedTools: controlledAllowedTools,
  }
}

try {
  assert.equal(
    (
      await runCase({
        agentId: 'resume-original-mode',
        parentMode: 'default',
        metadataMode: 'acceptEdits',
      })
    ).permissionMode,
    'acceptEdits',
  )
  for (const metadataMode of ['default', 'acceptEdits'] as const) {
    assert.equal(
      (
        await runCase({
          agentId: `resume-bypass-${metadataMode}`,
          parentMode: 'bypassPermissions',
          metadataMode,
        })
      ).permissionMode,
      'bypassPermissions',
    )
  }
  assert.equal(
    (
      await runCase({
        agentId: 'resume-legacy-bypass',
        parentMode: 'bypassPermissions',
      })
    ).permissionMode,
    'bypassPermissions',
  )
  assert.equal(
    (
      await runCase({
        agentId: 'resume-legacy-definition',
        parentMode: 'default',
        definitionMode: 'acceptEdits',
      })
    ).permissionMode,
    'acceptEdits',
  )
  assert.deepEqual(
    (
      await runCase({
        agentId: 'resume-definition-tools',
        parentMode: 'default',
        definitionTools: ['Read(example.txt)'],
      })
    ).allowedTools,
    ['Read(example.txt)'],
  )
} finally {
  resetGitFileWatcher()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (originalTestPersistence === undefined) {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  } else {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
  }
  rmSync(configDir, { recursive: true, force: true })
}

console.log('resumeAgent.permissionMode.test.ts passed')
