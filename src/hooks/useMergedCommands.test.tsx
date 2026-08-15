#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import React from 'react'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}
process.env.NODE_ENV = 'test'
process.env.ANTHROPIC_API_KEY = 'test-key'

const {
  clearCommandsCache,
  findCommand,
  findUserInvocableCommand,
  getCommands,
} = await import('../commands.js')
const { render } = await import('../ink.js')
const { clearBundledSkills } = await import('../skills/bundledSkills.js')
const { registerTerminalSkill } = await import('../skills/bundled/terminal.js')
const { useMergedCommands } = await import('./useMergedCommands.js')

type Command = Awaited<ReturnType<typeof getCommands>>[number]

clearBundledSkills()
clearCommandsCache()
registerTerminalSkill()

const initialCommands = await getCommands(process.cwd())
assert.equal(findCommand('terminal', initialCommands)?.loadedFrom, 'bundled')
assert.equal(
  findUserInvocableCommand('terminal', initialCommands)?.type,
  'local-jsx',
)

const additionalCommand = initialCommands.find(command => command.name === 'help')
assert.ok(additionalCommand)

let mergedCommands: Command[] | undefined
function CaptureMergedCommands(): null {
  mergedCommands = useMergedCommands(initialCommands, [additionalCommand])
  return null
}

class TestStdout extends Writable {
  columns = 120
  rows = 40
  isTTY = false

  _write(
    _chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback()
  }
}

const instance = await render(React.createElement(CaptureMergedCommands), {
  stdout: new TestStdout() as unknown as NodeJS.WriteStream,
  patchConsole: false,
})
await new Promise(resolve => setImmediate(resolve))
instance.unmount()
instance.cleanup()

assert.ok(mergedCommands)
assert.equal(findCommand('terminal', mergedCommands)?.loadedFrom, 'bundled')
assert.equal(
  findUserInvocableCommand('terminal', mergedCommands)?.type,
  'local-jsx',
  'merging additional command sources must preserve the built-in /terminal command',
)

console.log('useMergedCommands.test.tsx passed')
