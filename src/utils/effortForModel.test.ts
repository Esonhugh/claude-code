import { afterEach, beforeEach, expect, spyOn, test, mock } from 'bun:test'
import * as settings from './settings/settings.js'
import type { SettingsJson } from './settings/types.js'
import { getEffortForModel, getStartupEffort } from './effort.js'

let user: SettingsJson = {}
let flag: SettingsJson | null = null
beforeEach(() => {
  user = {
    modelSettings: {
      'claude-opus-5-5': { effortLevel: 'low' },
      'claude-sonnet-5-5': { effortLevel: 'high' },
    },
  }
  flag = null
  spyOn(settings, 'getInitialSettings').mockImplementation(() => ({ ...user, ...flag }))
  spyOn(settings, 'getSettingsForSource').mockImplementation(source =>
    source === 'userSettings' ? user : source === 'flagSettings' ? flag : null,
  )
  getStartupEffort(undefined)
})
afterEach(() => {
  getStartupEffort(undefined)
  mock.restore()
})

test('a model switch lands on the level saved for the new model, like official 2.1.319', () => {
  expect(getEffortForModel('sonnet')).toBe('high')
  expect(getEffortForModel('claude-opus-5-5[1m]')).toBe('low')
  expect(getEffortForModel('haiku')).toBeUndefined()
})

test('--effort and a flag-settings effortLevel hold across the switch', () => {
  flag = { effortLevel: 'medium' }
  expect(getEffortForModel('sonnet')).toBe('medium')
  flag = null
  getStartupEffort('xhigh')
  expect(getEffortForModel('sonnet')).toBe('xhigh')
})
