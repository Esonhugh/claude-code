import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { asAgentId } from '../../types/ids.js'
import { resetGitFileWatcher } from '../../utils/git/gitFilesystem.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { getCommandQueue } from '../../utils/messageQueueManager.js'
import { recordSidechainTranscript, writeAgentMetadata } from '../../utils/sessionStorage.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

mock.module('./runAgent.js', () => ({
  async *runAgent() {
    yield createAssistantMessage({ content: 'resumed reply' })
  },
}))

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const originalApiKey = process.env.ANTHROPIC_API_KEY
const configDir = mkdtempSync(join(tmpdir(), 'resume-agent-duration-test-'))
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
process.env.ANTHROPIC_API_KEY = 'test-resume-agent-duration-key'

const { resumeAgentBackground } = await import('./resumeAgent.js')

try {
  const agentId = 'resume-duration-agent'
  await writeAgentMetadata(asAgentId(agentId), { agentType: 'general-purpose', spawnDepth: 1 })
  await recordSidechainTranscript(
    [
      createUserMessage({ content: 'original prompt' }),
      createAssistantMessage({ content: 'first turn done' }),
    ],
    agentId,
  )

  const firstStart = Date.now() - 5_000
  let state = {
    ...getDefaultAppState(),
    mcp: { ...getDefaultAppState().mcp, tools: [], clients: [] },
    // The finished first run is still in the task list, as after a SendMessage.
    tasks: {
      [agentId]: {
        id: agentId, type: 'local_agent', status: 'completed', notified: true, startTime: firstStart,
        description: 'resume duration', agentId, agentType: 'general-purpose', prompt: 'original prompt',
        isBackgrounded: true, pendingMessages: [], retrieved: false, lastReportedToolCount: 0, lastReportedTokenCount: 0,
        spawnDepth: 1, outputFile: '', outputOffset: 0,
      },
    },
    agentNameRegistry: new Map(),
  }
  const result = await resumeAgentBackground({
    agentId,
    prompt: 'again',
    toolUseContext: {
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
      toolUseId: 'toolu_resume_duration',
      contentReplacementState: undefined,
      mods: { capture: () => undefined, invalidatePromptContext() {} },
      abortController: new AbortController(),
      messages: [],
    } as never,
    canUseTool: async () => ({ behavior: 'allow' }),
  })
  await (result as { execution?: Promise<unknown> }).execution
  let note: string | undefined
  for (let i = 0; i < 100 && !note; i++) {
    note = getCommandQueue().map(c => String(c.value)).find(v => v.includes('resumed reply'))
    if (!note) await new Promise(r => setTimeout(r, 20))
  }
  assert.ok(note, 'no completion notification')
  const durationMs = Number(note.match(/<duration_ms>(\d+)<\/duration_ms>/)?.[1])
  assert.ok(durationMs >= 5_000, `a resumed agent reports time since its first start, got ${durationMs}`)
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

console.log('resumeAgent.duration.test.ts passed')
