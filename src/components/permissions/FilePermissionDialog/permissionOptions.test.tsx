import { expect, test } from 'bun:test'
import React from 'react'
import { join } from 'path'
import { Text } from '../../../ink.js'
import { getDefaultAppState } from '../../../state/AppStateStore.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import { getCwd } from '../../../utils/cwd.js'
import { renderToString } from '../../../utils/staticRender.js'
import { getFilePermissionOptions } from './permissionOptions.js'

async function labels(
  filePath: string,
  operationType: 'read' | 'write',
  mode: ToolPermissionContext['mode'] = 'default',
): Promise<string[]> {
  const context = { ...getDefaultAppState().toolPermissionContext, mode }
  const options = getFilePermissionOptions({ filePath, toolPermissionContext: context, operationType })
  return Promise.all(options.map(async o => (await renderToString(<Text>{o.label}</Text>, 200)).trim()))
}

test('option 2 names the accept-edits switch for a write in the cwd, like official', async () => {
  expect(await labels(join(getCwd(), 'w.txt'), 'write')).toEqual([
    'Yes',
    'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
    'No',
  ])
})

test('option 2 adds the directory for a write outside the cwd', async () => {
  const [, session] = await labels('/opt/outside-cc-test/w.txt', 'write')
  expect(session).toContain('Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session; ')
  expect(session).toContain('Yes, and always allow access to /opt/outside-cc-test for this session (shift+tab)')
})

test('option 2 is the read rule for a read outside the cwd, without the shortcut', async () => {
  const [, session] = await labels('/opt/outside-cc-test/r.txt', 'read')
  expect(session).toBe('Yes, allow reading from /opt/outside-cc-test during this session')
})

test('no option 2 when the session updates would change nothing', async () => {
  expect(await labels(join(getCwd(), 'w.txt'), 'write', 'acceptEdits')).toEqual(['Yes', 'No'])
})

test('.claude folder writes use the official labels', async () => {
  const [, session] = await labels(join(getCwd(), '.claude', 'x.md'), 'write')
  expect(session).toBe("Yes, and allow Claude to edit files in this project's .claude folder for this session")
})
