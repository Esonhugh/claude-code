#!/usr/bin/env bun
import assert from 'node:assert/strict'

import {
  resetStateForTests,
  setAllowedSettingSources,
} from '../../bootstrap/state.js'
import { setCachedSettingsForSource } from '../../utils/settings/settingsCache.js'

process.env.NODE_ENV = 'test'
resetStateForTests()
import {
  formatListWithAnd,
  getProjectDirectorySummary,
  getProjectPermissionSummary,
} from './utils.js'

setCachedSettingsForSource('projectSettings', {
  permissions: {
    allow: ['Read', 'Bash(bun test:*)', 'Read'],
    additionalDirectories: ['relative', '/absolute'],
  },
})
setCachedSettingsForSource('localSettings', {
  permissions: {
    allow: ['WebSearch', 'McpTool(unsafe\u0007value\u202Ehidden)'],
    additionalDirectories: ['../parent\u2066hidden', '/absolute'],
  },
})

const permissions = getProjectPermissionSummary()
assert.equal(permissions.rawCount, 5)
assert.deepEqual(permissions.sources, [
  '.claude/settings.json',
  '.claude/settings.local.json',
])
assert.deepEqual(permissions.values, [
  'WebSearch',
  'Bash(bun test:*)',
  'Read',
  'McpTool(unsafevaluehidden)',
])

const directories = getProjectDirectorySummary()
assert.equal(directories.rawCount, 4)
assert.deepEqual(directories.sources, [
  '.claude/settings.json',
  '.claude/settings.local.json',
])
assert.deepEqual(directories.values, [
  '/absolute',
  '../parenthidden',
  'relative',
])

setCachedSettingsForSource('projectSettings', {
  permissions: {
    additionalDirectories: [`${'a'.repeat(59)}😀suffix`],
  },
})
assert.deepEqual(getProjectDirectorySummary().values, [
  '/absolute',
  '../parenthidden',
  `${'a'.repeat(59)}😀…`,
])

const sharedPrefix = 'x'.repeat(60)
setCachedSettingsForSource('projectSettings', {
  permissions: {
    allow: [`Bash(${sharedPrefix}first)`, `Bash(${sharedPrefix}second)`],
    additionalDirectories: [`${sharedPrefix}first`, `${sharedPrefix}second`],
  },
})
assert.deepEqual(getProjectPermissionSummary().values, [
  'WebSearch',
  `${`Bash(${sharedPrefix}first)`.slice(0, 60)}…`,
  `${`Bash(${sharedPrefix}second)`.slice(0, 60)}…`,
  'McpTool(unsafevaluehidden)',
])
assert.deepEqual(getProjectDirectorySummary().values, [
  '/absolute',
  '../parenthidden',
  `${sharedPrefix}…`,
  `${sharedPrefix}…`,
])

setCachedSettingsForSource('projectSettings', {
  permissions: {
    allow: ['Read', 'Bash(bun test:*)', 'Read'],
    additionalDirectories: ['relative', '/absolute'],
  },
})

setAllowedSettingSources(['userSettings'])
assert.deepEqual(getProjectPermissionSummary(), {
  values: [],
  sources: [],
  rawCount: 0,
})
assert.deepEqual(getProjectDirectorySummary(), {
  values: [],
  sources: [],
  rawCount: 0,
})
setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])

setCachedSettingsForSource('policySettings', {
  allowManagedPermissionRulesOnly: true,
})
assert.deepEqual(getProjectPermissionSummary(), {
  values: [],
  sources: [],
  rawCount: 0,
})
setCachedSettingsForSource('policySettings', null)

assert.equal(
  formatListWithAnd(['one', 'two', 'three'], 2),
  'one, two, and 1 more',
)

setCachedSettingsForSource('projectSettings', null)
setCachedSettingsForSource('localSettings', null)

console.log('TrustDialog/utils.test.ts passed')
