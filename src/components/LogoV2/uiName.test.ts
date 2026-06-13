import assert from 'node:assert/strict'

import { SettingsSchema } from '../../utils/settings/types.js'
import { DEFAULT_UI_NAME, getConfiguredUiName } from './uiName.js'

assert.equal(DEFAULT_UI_NAME, 'EsonClaw')
assert.equal(getConfiguredUiName({}), 'EsonClaw')
assert.equal(getConfiguredUiName({ uiName: 'My Console' }), 'My Console')
assert.equal(getConfiguredUiName({ uiName: '  My Console  ' }), 'My Console')
assert.equal(getConfiguredUiName({ uiName: '   ' }), 'EsonClaw')

const parsed = SettingsSchema().parse({ uiName: 'Custom UI' })
assert.equal(parsed.uiName, 'Custom UI')

const invalid = SettingsSchema().safeParse({ uiName: ['P', 'R', 'T', 'S'] })
assert.equal(invalid.success, false)

console.log('uiName.test.ts passed')
