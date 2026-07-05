import assert from 'node:assert/strict'
import type { AgentToolProgress } from '../../types/tools.js'

const firstProgress: AgentToolProgress = {
  type: 'agent_progress',
  message: {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    },
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-07-05T00:00:00.000Z',
  } as never,
  prompt: 'hello',
  agentId: 'agent-test',
  agentType: 'general-purpose',
  description: 'Recover progress parity',
  resolvedModel: 'claude-sonnet-4-6',
}

assert.equal(firstProgress.resolvedModel, 'claude-sonnet-4-6')
assert.equal(firstProgress.agentType, 'general-purpose')
assert.equal(firstProgress.description, 'Recover progress parity')

console.log('agentProgressPayload.test.ts passed')
