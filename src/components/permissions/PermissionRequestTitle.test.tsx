import { expect, test } from 'bun:test'
import React from 'react'
import { renderToString } from '../../utils/staticRender.js'
import { PermissionRequestTitle } from './PermissionRequestTitle.js'

test('labels a subagent ask with its source agent and keeps the worker badge', async () => {
  const agent = await renderToString(
    <PermissionRequestTitle
      title="Bash command"
      workerBadge={{ name: 'general-purpose', color: 'cyan', label: 'from the general-purpose agent' }}
    />,
    80,
  )
  expect(agent.trim()).toBe('Bash command · from the general-purpose agent')
  const worker = await renderToString(
    <PermissionRequestTitle title="Bash command" workerBadge={{ name: 'researcher', color: 'cyan' }} />,
    80,
  )
  expect(worker.trim()).toBe('Bash command · @researcher')
})
