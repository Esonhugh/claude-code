#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalHome = process.env.HOME
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalUseOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const tempHome = mkdtempSync(join(tmpdir(), 'daybreak-command-test-'))
process.env.HOME = tempHome
process.env.CLAUDE_CONFIG_DIR = tempHome

try {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  const { executeDaybreak, showCurrentDaybreak } = await import('./daybreak.js')
  const command = (await import('./index.js')).default
  const { getSettingsForSource } = await import('../../utils/settings/settings.js')
  const { SettingsSchema } = await import('../../utils/settings/types.js')

  assert.equal(command.isEnabled?.(), true)
  assert.equal(command.argumentHint, '[blue|red|off]')
  assert.equal(showCurrentDaybreak(), 'Daybreak is off; standard access program selected. Usage: /daybreak [blue|red|off]')

  const blue = executeDaybreak('blue')
  assert.equal(blue, 'Daybreak set to blue')
  assert.equal(getSettingsForSource('userSettings')?.daybreak, 'blue')

  const red = executeDaybreak('RED')
  assert.equal(red, 'Daybreak set to red')
  assert.equal(getSettingsForSource('userSettings')?.daybreak, 'red')
  assert.equal(showCurrentDaybreak(), 'Current Daybreak program: red. Usage: /daybreak [blue|red|off]')

  const off = executeDaybreak('OFF')
  assert.equal(off, 'Daybreak disabled; standard access program selected')
  assert.equal(getSettingsForSource('userSettings')?.daybreak, 'off')
  assert.equal(showCurrentDaybreak(), 'Daybreak is off; standard access program selected. Usage: /daybreak [blue|red|off]')

  const settingsPath = join(tempHome, 'settings.json')
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).daybreak, 'off')
  const beforeInvalid = readFileSync(settingsPath, 'utf8')
  assert.equal(executeDaybreak('purple'), 'Invalid argument: purple. Usage: /daybreak [blue|red|off]')
  assert.equal(readFileSync(settingsPath, 'utf8'), beforeInvalid)
  assert.equal(getSettingsForSource('userSettings')?.daybreak, 'off')

  assert.equal(SettingsSchema().parse({ daybreak: 'blue' }).daybreak, 'blue')
  assert.equal(SettingsSchema().parse({ daybreak: 'red' }).daybreak, 'red')
  assert.equal(SettingsSchema().parse({ daybreak: 'off' }).daybreak, 'off')
  assert.equal(SettingsSchema().safeParse({ daybreak: 'purple' }).success, false)

  delete process.env.CLAUDE_CODE_USE_OPENAI
  assert.equal(command.isEnabled?.(), false)

  console.log('daybreak.test.ts passed')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalUseOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalUseOpenAI
}
