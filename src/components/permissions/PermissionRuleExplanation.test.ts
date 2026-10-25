import { expect, test } from 'bun:test'
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js'
import { AUTO_MODE_CLASSIFIER_UNAVAILABLE_REASON } from '../../utils/permissions/PermissionResult.js'
import { permissionModeAskNote } from './PermissionRuleExplanation.js'

test('modes that usually decide alone say why they still ask', () => {
  // Auto's title is compiled behind TRANSCRIPT_CLASSIFIER.
  const auto = permissionModeTitle('auto')
  expect(permissionModeAskNote('bypassPermissions', { type: 'safetyCheck', reason: 'sensitive file', classifierApprovable: false }))
    .toBe('Asked even in Bypass Permissions mode: safety checks on protected paths and commands apply in every mode.')
  expect(permissionModeAskNote('auto', { type: 'hook', hookName: 'tool.check', hookSource: 'plugin:modcheck', reason: 'MODASK' }))
    .toBe(`Asked even in ${auto} mode: plugin modcheck asked through tool.check.`)
  expect(permissionModeAskNote('acceptEdits', { type: 'hook', hookName: 'PreToolUse:Bash' }))
    .toBe('Asked even in Accept edits mode: hook PreToolUse:Bash asked.')
  expect(permissionModeAskNote('auto', { type: 'other', reason: AUTO_MODE_CLASSIFIER_UNAVAILABLE_REASON }))
    .toBe(`Asked even in ${auto} mode: the auto mode classifier is unavailable.`)
})

test('no note where the mode itself explains the prompt', () => {
  expect(permissionModeAskNote('default', { type: 'safetyCheck', reason: 'x', classifierApprovable: false })).toBeNull()
  expect(permissionModeAskNote('plan', { type: 'hook', hookName: 'PreToolUse:Bash' })).toBeNull()
  expect(permissionModeAskNote('acceptEdits', undefined)).toBeNull()
  expect(permissionModeAskNote('auto', { type: 'other', reason: 'something else' })).toBeNull()
})
