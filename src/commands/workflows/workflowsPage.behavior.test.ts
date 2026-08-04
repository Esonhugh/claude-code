#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  shouldOpenWorkflowsPageForArgs,
  workflowDialogDismissedMessage,
} from './workflowsMessages.js'

assert.equal(workflowDialogDismissedMessage, 'Dynamic workflows dialog dismissed')
assert.equal(shouldOpenWorkflowsPageForArgs(undefined), true)
assert.equal(shouldOpenWorkflowsPageForArgs(''), true)
assert.equal(shouldOpenWorkflowsPageForArgs('list'), false)
assert.equal(shouldOpenWorkflowsPageForArgs('show compatibility-smoke'), false)
assert.equal(shouldOpenWorkflowsPageForArgs('dry-run compatibility-smoke'), false)
assert.equal(shouldOpenWorkflowsPageForArgs('run deep-research -- topic'), false)
assert.equal(shouldOpenWorkflowsPageForArgs('templates'), false)
assert.equal(shouldOpenWorkflowsPageForArgs('status workflow-task-id'), false)
assert.equal(shouldOpenWorkflowsPageForArgs('detail workflow-task-id'), false)
assert.equal(shouldOpenWorkflowsPageForArgs('pause workflow-task-id'), false)
assert.equal(shouldOpenWorkflowsPageForArgs('resume workflow-task-id'), false)
assert.equal(shouldOpenWorkflowsPageForArgs('retry-agent workflow-task-id phase agent'), false)
assert.equal(shouldOpenWorkflowsPageForArgs('skip-agent workflow-task-id phase agent'), false)

console.log('workflowsPage.behavior.test.ts passed')
