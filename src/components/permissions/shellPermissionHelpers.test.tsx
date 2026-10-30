import { expect, test } from 'bun:test'
import React from 'react'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import { renderToString } from '../../utils/staticRender.js'
import { generateShellSuggestionsLabel, shellSuggestionUpdates } from './shellPermissionHelpers.js'

test('"always allow access" applies only the rules and directories the label shows', () => {
  // A write command in the cwd suggests both a directory and an acceptEdits switch;
  // the option only names the directory, so the mode switch must not ride along.
  const suggestions: PermissionUpdate[] = [
    { type: 'addDirectories', directories: ['/work'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }], behavior: 'allow', destination: 'localSettings' },
  ]
  expect(shellSuggestionUpdates(suggestions)).toEqual([suggestions[0]!, suggestions[2]!])
})

test('like 2.1.311, the directory label names the full path and drops an over-long list', async () => {
  const dirs = (directories: string[]): PermissionUpdate[] => [{ type: 'addDirectories', directories, destination: 'session' }]
  const one = await renderToString(<>{generateShellSuggestionsLabel(dirs(['/srv/app/work']), 'Bash')}</>, 200)
  expect(one).toContain('Yes, and always allow access to /srv/app/work from this project')
  const three = await renderToString(<>{generateShellSuggestionsLabel(dirs(['/a', '/b', '/c']), 'Bash')}</>, 200)
  expect(three).toContain('Yes, and always allow access to /a, /b, and /c from this project')
  expect(generateShellSuggestionsLabel(dirs(['/' + 'x'.repeat(170)]), 'Bash')).toBeNull()
})
