import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { asAgentId } from '../../types/ids.js'
import { resetGitFileWatcher } from '../../utils/git/gitFilesystem.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { recordSidechainTranscript, writeAgentMetadata } from '../../utils/sessionStorage.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

let seen: { subagentDepth?: number; spawnDepth?: number; messages: string[] } | undefined

mock.module('./runAgent.js', () => ({
  async *runAgent(params: {
    spawnDepth?: number
    promptMessages: { message: { content: unknown } }[]
    toolUseContext: { options: { subagentDepth?: number } }
  }) {
    seen = {
      subagentDepth: params.toolUseContext.options.subagentDepth,
      spawnDepth: params.spawnDepth,
      messages: params.promptMessages.map(m => JSON.stringify(m.message.content)),
    }
    yield* []
  },
}))

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const originalApiKey = process.env.ANTHROPIC_API_KEY
const configDir = mkdtempSync(join(tmpdir(), 'resume-agent-depth-test-'))
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
process.env.ANTHROPIC_API_KEY = 'test-resume-agent-depth-key'

const { resumeAgentBackground } = await import('./resumeAgent.js')

try {
  const agentId = 'resume-depth-agent'
  await writeAgentMetadata(asAgentId(agentId), { agentType: 'general-purpose', spawnDepth: 4 })
  // A parked owner is woken right after its last turn: that turn may still be
  // in the write queue when the resume reads the transcript.
  await recordSidechainTranscript(
    [
      createUserMessage({ content: 'original prompt' }),
      createAssistantMessage({ content: 'first turn done' }),
    ],
    agentId,
  )

  let state = {
    ...getDefaultAppState(),
    mcp: { ...getDefaultAppState().mcp, tools: [], clients: [] },
    tasks: {},
    agentNameRegistry: new Map(),
  }
  await resumeAgentBackground({
    agentId,
    prompt: 'child finished',
    toolUseContext: {
      // The waking context belongs to whoever delivered the notification.
      options: {
        tools: [FileReadTool],
        mainLoopModel: 'claude-sonnet-4-6',
        mcpClients: [],
        subagentDepth: 3,
        agentDefinitions: { activeAgents: [GENERAL_PURPOSE_AGENT], inactiveAgents: [], allowedAgentTypes: undefined },
      },
      getAppState: () => state,
      setAppState: (updater: (prev: typeof state) => typeof state) => {
        state = updater(state)
      },
      toolUseId: 'toolu_resume_depth',
      contentReplacementState: undefined,
      mods: { capture: () => undefined, invalidatePromptContext() {} },
      abortController: new AbortController(),
      messages: [],
    } as never,
    canUseTool: async () => ({ behavior: 'allow' }),
  })
  for (let i = 0; i < 50 && !seen; i++) await new Promise(r => setTimeout(r, 20))
  assert.ok(seen, 'runAgent was not called')
  assert.ok(
    seen.messages.some(m => m.includes('first turn done')),
    `resume lost the unflushed turn: ${seen.messages.join(' | ')}`,
  )
  assert.equal(seen.spawnDepth, 4)
  assert.equal(seen.subagentDepth, 4, 'a resumed agent keeps its own nesting depth, not the waker\'s')
} finally {
  resetGitFileWatcher()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalTestPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
  rmSync(configDir, { recursive: true, force: true })
}

console.log('resumeAgent.depth.test.ts passed')
