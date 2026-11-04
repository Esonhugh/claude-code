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

// Each run records its last prompt and stays running until released.
const runPrompts: string[] = []
let release!: () => void
const held = new Promise<void>(resolve => (release = resolve))
mock.module('./runAgent.js', () => ({
  async *runAgent(params: { promptMessages: { message: { content: unknown } }[] }) {
    runPrompts.push(String(params.promptMessages.at(-1)!.message.content))
    await held
    yield createAssistantMessage({ content: 'resumed reply' })
  },
}))

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const originalApiKey = process.env.ANTHROPIC_API_KEY
const configDir = mkdtempSync(join(tmpdir(), 'resume-agent-concurrent-test-'))
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
process.env.ANTHROPIC_API_KEY = 'test-resume-agent-concurrent-key'

const { resumeAgentBackground } = await import('./resumeAgent.js')

try {
  const agentId = 'resume-concurrent-agent'
  await writeAgentMetadata(asAgentId(agentId), { agentType: 'general-purpose', spawnDepth: 1 })
  await recordSidechainTranscript([createUserMessage({ content: 'original prompt' }), createAssistantMessage({ content: 'first turn done' })], agentId)

  let state = {
    ...getDefaultAppState(),
    mcp: { ...getDefaultAppState().mcp, tools: [], clients: [] },
    tasks: {
      [agentId]: {
        id: agentId, type: 'local_agent', status: 'completed', notified: true, startTime: Date.now() - 5_000,
        description: 'resume concurrent', agentId, agentType: 'general-purpose', prompt: 'original prompt',
        isBackgrounded: true, pendingMessages: [], retrieved: false, lastReportedToolCount: 0, lastReportedTokenCount: 0,
        spawnDepth: 1, outputFile: '', outputOffset: 0,
      },
    },
    agentNameRegistry: new Map(),
  }
  const toolUseContext = {
    options: {
      tools: [FileReadTool],
      mainLoopModel: 'claude-sonnet-4-6',
      mcpClients: [],
      agentDefinitions: { activeAgents: [GENERAL_PURPOSE_AGENT], inactiveAgents: [], allowedAgentTypes: undefined },
    },
    getAppState: () => state,
    setAppState: (updater: (prev: typeof state) => typeof state) => {
      state = updater(state)
    },
    toolUseId: 'toolu_resume_concurrent',
    contentReplacementState: undefined,
    mods: { capture: () => undefined, invalidatePromptContext() {} },
    abortController: new AbortController(),
    messages: [],
  } as never
  const canUseTool = async () => ({ behavior: 'allow' }) as never

  // Two messages typed into the finished agent before the first resume has registered it.
  const first = resumeAgentBackground({ agentId, prompt: 'FIRST', toolUseContext, canUseTool, fromUser: true })
  const second = resumeAgentBackground({ agentId, prompt: 'SECOND', toolUseContext, canUseTool, fromUser: true })
  await Promise.all([first, second])
  const deadline = Date.now() + 5_000
  while (runPrompts.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))

  // One run, started by the first message; the second waits for it as a queued user message.
  assert.deepEqual(runPrompts, ['FIRST'])
  const task = state.tasks[agentId] as { status: string; pendingMessages: unknown[] }
  assert.equal(task.status, 'running')
  assert.deepEqual(task.pendingMessages, [{ text: 'SECOND', fromUser: true }])
  release()
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

console.log('resumeAgent.concurrent.test.ts passed')
