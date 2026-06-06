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

console.log('workflowsPage.behavior.test.ts passed')
