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

const { useReplCommands } = await import('./useMergedCommands.js')
const local = { ...additionalCommand, name: 'local-command' } as Command
const oldPlugin = { ...additionalCommand, type: 'prompt', source: 'plugin', name: 'plugin-command' } as unknown as Command
const removedPlugin = { ...oldPlugin, name: 'removed-plugin' } as Command
const refreshedPlugin = { ...oldPlugin, description: 'refreshed version' } as Command
const startup = [local, oldPlugin, removedPlugin]
let current: Command[] = []
function CaptureReload({ reloadKey, plugins }: { reloadKey: number; plugins: Command[] }): null {
  current = useReplCommands(startup, plugins, [], reloadKey, false, false)
  return null
}
const reloadInstance = await render(React.createElement(CaptureReload, { reloadKey: 0, plugins: [] }), {
  stdout: new TestStdout() as unknown as NodeJS.WriteStream,
  patchConsole: false,
})
try {
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(current.find(command => command.name === oldPlugin.name), oldPlugin)
  for (const reloadKey of [1, 2]) {
    reloadInstance.rerender(React.createElement(CaptureReload, { reloadKey, plugins: [refreshedPlugin, refreshedPlugin] }))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(current, [local, refreshedPlugin])
    assert.equal(current.filter(command => command.name === refreshedPlugin.name).length, 1)
    assert.equal(current[1], refreshedPlugin)
  }
} finally {
  reloadInstance.unmount()
  reloadInstance.cleanup()
}

const { createModCommands } = await import('../services/mods/commands.js')
const modCommands = createModCommands({getBuiltinCommands: () => [], run: async () => ({})})
const mcpCommand = { ...additionalCommand, name: 'mcp-command' } as Command
function CaptureMods({ disabled = false, remote = false }: {disabled?: boolean; remote?: boolean}): null {
  current = useReplCommands([local], [refreshedPlugin], [mcpCommand], 0, remote, disabled, modCommands)
  return null
}
const modInstance = await render(React.createElement(CaptureMods), {
  stdout: new TestStdout() as unknown as NodeJS.WriteStream,
  patchConsole: false,
})
try {
  await new Promise(resolve => setImmediate(resolve))
  const owner = {}
  modCommands.register(owner, {name:'mod-panel', description:'Panel'})
  modCommands.commit(owner)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(current.map(command => command.name), ['local-command', 'plugin-command', 'mcp-command', 'mod-panel'])
  modCommands.register(owner, {name:'mod-late', description:'Late'})
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(current.map(command => command.name), ['local-command', 'plugin-command', 'mcp-command', 'mod-panel', 'mod-late'])
  modCommands.register(owner, {name:'mod-panel', description:'Updated panel'})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(current.find(command => command.name === 'mod-panel')?.description, 'Updated panel')
  assert.equal(current.filter(command => command.name === 'mod-late').length, 1)
  for (const props of [{disabled:true}, {remote:true}]) {
    modInstance.rerender(React.createElement(CaptureMods, props))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(current.map(command => command.name), props.disabled ? [] : ['local-command'])
  }
  modInstance.rerender(React.createElement(CaptureMods))
  await new Promise(resolve => setImmediate(resolve))
  modCommands.release(owner)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(current, [local, refreshedPlugin, mcpCommand])
} finally {
  modInstance.unmount()
  modInstance.cleanup()
}

console.log('useMergedCommands.test.tsx passed')
