import { expect, test } from 'bun:test'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import { shellSuggestionUpdates } from './shellPermissionHelpers.js'

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
