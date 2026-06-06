#!/usr/bin/env node
import assert from 'node:assert/strict'

import workflowsCommand from './index.js'

assert.equal(workflowsCommand.type, 'local-jsx')
const module = await workflowsCommand.load()
assert.equal(typeof module.call, 'function')
assert.equal(typeof module.WorkflowsPage, 'function')

console.log('workflowsPage.test.ts passed')
