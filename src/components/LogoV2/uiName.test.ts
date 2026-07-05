import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import React from 'react'

import { setAllowedSettingSources, setFlagSettingsInline } from '../../bootstrap/state.js'
import { render } from '../../ink.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { AppStateProvider } from '../../state/AppState.js'
import { SettingsSchema } from '../../utils/settings/types.js'
import { LogoV2 } from './LogoV2.js'
import { DEFAULT_UI_NAME, getConfiguredUiName } from './uiName.js'

class TestStdout extends Writable {
  columns = 100
  rows = 40
  isTTY = false
  output = ''

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.output += chunk.toString()
    callback()
  }
}

assert.equal(DEFAULT_UI_NAME, 'EsonClaw')
assert.equal(getConfiguredUiName({}), 'EsonClaw')
assert.equal(getConfiguredUiName({ uiName: 'My Console' }), 'My Console')
assert.equal(getConfiguredUiName({ uiName: '  My Console  ' }), 'My Console')
assert.equal(getConfiguredUiName({ uiName: '   ' }), 'EsonClaw')

const parsed = SettingsSchema().parse({ uiName: 'Custom UI' })
assert.equal(parsed.uiName, 'Custom UI')

const invalid = SettingsSchema().safeParse({ uiName: ['P', 'R', 'T', 'S'] })
assert.equal(invalid.success, false)

process.env.NODE_ENV = 'test'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.CLAUDE_CODE_FORCE_FULL_LOGO = '1'
process.env.IS_DEMO = '1'
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: '0.0.0-test',
}
setAllowedSettingSources(['flagSettings'])
setFlagSettingsInline({ uiName: 'Custom UI' })
resetSettingsCache()

const stdout = new TestStdout()
const instance = await render(
  React.createElement(
    AppStateProvider,
    null,
    React.createElement(LogoV2),
  ),
  { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false },
)
await new Promise(resolve => setImmediate(resolve))
instance.unmount()
instance.cleanup()

assert.match(stdout.output, /Custom UI v0\.0\.0-test/)
assert.doesNotMatch(stdout.output, /Claude Code v0\.0\.0-test/)

const compactStdout = new TestStdout()
compactStdout.columns = 60
const compactInstance = await render(
  React.createElement(
    AppStateProvider,
    null,
    React.createElement(LogoV2),
  ),
  { stdout: compactStdout as unknown as NodeJS.WriteStream, patchConsole: false },
)
await new Promise(resolve => setImmediate(resolve))
compactInstance.unmount()
compactInstance.cleanup()

assert.match(compactStdout.output, /Custom UI/)
assert.doesNotMatch(compactStdout.output, /Claude Code/)

console.log('uiName.test.ts passed')
