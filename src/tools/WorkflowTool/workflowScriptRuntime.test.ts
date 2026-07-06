#!/usr/bin/env node
import assert from 'node:assert/strict'

import { classifyWorkflowAgentError } from './workflowScriptRuntime.js'

assert.equal(
  classifyWorkflowAgentError(new Error('Concurrency limit exceeded for user fakeadmin')),
  'concurrency_limit',
)

assert.equal(
  classifyWorkflowAgentError(new Error('agent stalled after 120000ms')),
  'stalled',
)

assert.equal(
  classifyWorkflowAgentError(new Error('permission denied by permission policy')),
  'permission_denied',
)

assert.equal(
  classifyWorkflowAgentError(new Error('agent crashed unexpectedly')),
  'agent_failed',
)

console.log('workflowScriptRuntime.test.ts passed')
