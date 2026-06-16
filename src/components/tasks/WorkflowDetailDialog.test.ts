#!/usr/bin/env bun
import assert from 'node:assert/strict'

import { workflowDetailStatusWord } from './workflowDetailModel.js'

assert.equal(workflowDetailStatusWord('completed'), 'done')
assert.equal(workflowDetailStatusWord('failed'), 'failed')
assert.equal(workflowDetailStatusWord('pending'), 'paused')
assert.equal(workflowDetailStatusWord('killed'), 'killed')
assert.equal(workflowDetailStatusWord('running'), 'running')

console.log('WorkflowDetailDialog.test.ts passed')
