import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildLocalExecutionPlan,
  buildOfficialExecutionPlan,
} from './executors.js'

const testCase = {
  id: 'ARGS-001',
  title: 'object args',
  category: 'args' as const,
  prompt: 'Run object args workflow.',
  workflowName: 'object-args',
  args: { topic: 'compatibility' },
  fixtureFiles: {},
  env: { CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS' },
  timeoutMs: 120000,
  maxOutputBytes: 200000,
  comparison: { mode: 'schema' as const, requiredEventTypes: [], proseFields: [] },
  confirmation: { rerunsOnDifference: 2 },
}

describe('workflow compatibility executors', () => {
  it('builds the official binary execution plan', () => {
    const plan = buildOfficialExecutionPlan({
      testCase,
      workspacePath: '/tmp/official',
      officialBinary: '/opt/homebrew/bin/claude',
    })

    assert.equal(plan.command, '/opt/homebrew/bin/claude')
    assert.equal(plan.args[0], '-p')
    assert.equal(plan.args[1], '--bare')
    assert.match(plan.args[2], /Run object args workflow\./)
    assert.match(plan.args[2], /Workflow\(\{\n {2}"name": "object-args"/)
    assert.match(plan.args[2], /"topic": "compatibility"/)
    assert.equal(plan.cwd, '/tmp/official')
    assert.equal(plan.env.CLAUDE_CODE_RECOVER_FEATURES, 'WORKFLOW_SCRIPTS')
    assert.equal(plan.timeoutMs, 30000)
  })

  it('builds the local repository execution plan', () => {
    const plan = buildLocalExecutionPlan({
      testCase,
      workspacePath: '/tmp/local',
      projectRoot: '/repo',
    })

    assert.equal(plan.command, process.execPath)
    assert.equal(plan.args[0], '/repo/dist/cli.js')
    assert.equal(plan.args[1], '-p')
    assert.equal(plan.args[2], '--bare')
    assert.match(plan.args[3], /Run object args workflow\./)
    assert.match(plan.args[3], /Workflow\(\{\n {2}"name": "object-args"/)
    assert.match(plan.args[3], /"topic": "compatibility"/)
    assert.equal(plan.cwd, '/tmp/local')
    assert.equal(plan.env.CLAUDE_CODE_RECOVER_FEATURES, 'WORKFLOW_SCRIPTS')
  })
})
