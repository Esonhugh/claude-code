import assert from 'node:assert/strict'

import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
} from '../../constants/tools.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { AGENT_TOOL_NAME } from './constants.js'
import { createSubagentContext } from '../../utils/forkedAgent.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_DEPTH_LIMIT_MESSAGE,
  assertCanSpawnNestedSubagent,
  getCurrentSubagentDepth,
  getNextSubagentDepth,
} from './subagentDepth.js'

assert.equal(MAX_SUBAGENT_DEPTH, 5)
assert.equal(getCurrentSubagentDepth({}), 0)
assert.equal(getCurrentSubagentDepth({ subagentDepth: 1 }), 1)
assert.equal(getNextSubagentDepth({}), 1)
assert.equal(getNextSubagentDepth({ subagentDepth: 4 }), 5)
assert.doesNotThrow(() => assertCanSpawnNestedSubagent({ subagentDepth: 4 }))
assert.equal(ALL_AGENT_DISALLOWED_TOOLS.has(AGENT_TOOL_NAME), false)
assert.equal(ASYNC_AGENT_ALLOWED_TOOLS.has(AGENT_TOOL_NAME), true)
assert.throws(
  () => assertCanSpawnNestedSubagent({ subagentDepth: 5 }),
  error => error instanceof Error && error.message === SUBAGENT_DEPTH_LIMIT_MESSAGE,
)

const parentContext = {
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
      inactiveAgents: [],
      allowedAgentTypes: undefined,
    },
    subagentDepth: 2,
  },
  abortController: new AbortController(),
  readFileState: createFileStateCacheWithSizeLimit(10),
  getAppState: () => ({
    toolPermissionContext: getEmptyToolPermissionContext(),
  }),
  setAppState: () => {},
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
}

const childContext = createSubagentContext(parentContext as never)
assert.equal(childContext.options.subagentDepth, 3)

const explicitChildContext = createSubagentContext(parentContext as never, {
  options: { ...parentContext.options, subagentDepth: 5 } as never,
})
assert.equal(explicitChildContext.options.subagentDepth, 5)

console.log('subagentDepth.test.ts passed')
