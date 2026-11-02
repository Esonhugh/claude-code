import { expect, test } from 'bun:test'
import React from 'react'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { renderToString } from '../../utils/staticRender.js'
import { renderToolResultMessage } from './UI.js'
import { WorkflowFacadeTool } from './WorkflowFacadeTool.js'

const script = `export const meta = { name: 'mt-wf', description: 'multi-turn probe workflow' }
return 1
`

test('labels the call like official: meta description, or "dynamic workflow: <name>"', () => {
  const label = (input: object) =>
    WorkflowFacadeTool.renderToolUseMessage(input as never)
  expect(label({ script })).toBe('multi-turn probe workflow')
  expect(label({ name: 'deep-research' })).toBe('dynamic workflow: deep-research')
  expect(label({ script: 'return 1' })).toBe('return 1')
})

async function drawResult(tasks: object): Promise<string> {
  const state = { ...getDefaultAppState(), tasks } as never
  return (await renderToString(
    <AppStateProvider initialState={state}>
      {renderToolResultMessage('Workflow launched in background. Task ID: w1')}
    </AppStateProvider>,
    80,
  )).trim()
}

test('a finished run shows the official completion line under the call', async () => {
  const done = {
    id: 'w1',
    type: 'local_workflow',
    status: 'completed',
    startTime: 1_000,
    endTime: 1_400,
    agentCount: 1,
    tokenCount: 11,
  }
  expect(await drawResult({ w1: done })).toContain('Completed in 0s · 1 agent · 11 tokens')
  expect(await drawResult({ w1: { ...done, status: 'running' } })).toContain(
    'Running in background · /workflows to monitor and save',
  )
  expect(await drawResult({})).toContain('/workflows to view dynamic workflow runs')
})
