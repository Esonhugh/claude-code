import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { GENERAL_PURPOSE_AGENT } from '../AgentTool/built-in/generalPurposeAgent.js'
import { spawnTeammate } from './spawnMultiAgent.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'spawn-multi-agent-test-'))
process.env.CLAUDE_CONFIG_DIR = configDir

let setAppStateCalls = 0
const context = {
  options: {
    agentDefinitions: {
      activeAgents: [GENERAL_PURPOSE_AGENT],
      inactiveAgents: [],
      allowedAgentTypes: undefined,
    },
  },
  toolUseId: 'toolu_spawn_test',
  getAppState: () => ({
    mainLoopModel: 'claude-sonnet-4-6',
    toolPermissionContext: getEmptyToolPermissionContext(),
    teamContext: { teamName: 'default' },
  }),
  setAppState: () => {
    setAppStateCalls += 1
  },
} as never

let missingTeamError: unknown
try {
  await spawnTeammate(
    {
      name: 'worker',
      prompt: 'do it',
    },
    context,
  )
} catch (error) {
  missingTeamError = error
}

assert.ok(missingTeamError instanceof Error)
assert.equal(
  missingTeamError.message,
  'Team "default" does not exist. Call spawnTeam first to create the team.',
)
assert.equal(setAppStateCalls, 0)

if (originalConfigDir === undefined) {
  delete process.env.CLAUDE_CONFIG_DIR
} else {
  process.env.CLAUDE_CONFIG_DIR = originalConfigDir
}
rmSync(configDir, { recursive: true, force: true })

console.log('spawnMultiAgent.test.ts passed')
