#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  shouldOpenWorkflowsPageForArgs,
  workflowDialogDismissedMessage,
} from './workflowsMessages.js'

assert.equal(workflowDialogDismissedMessage, 'Dynamic workflows dialog dismissed')
assert.equal(shouldOpenWorkflowsPageForArgs(undefined), true)
assert.equal(shouldOpenWorkflowsPageForArgs(''), true)
assert.equal(shouldOpenWorkflowsPageForArgs('list'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('show compatibility-smoke'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('dry-run compatibility-smoke'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('run deep-research -- topic'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('templates'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('status workflow-task-id'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('detail workflow-task-id'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('pause workflow-task-id'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('resume workflow-task-id'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('retry-agent workflow-task-id phase agent'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('skip-agent workflow-task-id phase agent'), true)

console.log('workflowsPage.behavior.test.ts passed')
