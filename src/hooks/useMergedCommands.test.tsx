#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  output = ''

  _write(
    _chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.output += _chunk.toString()
    callback()
  }
}

class TestStdin extends Readable {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
  _read() {}
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

const { createModsRuntime } = await import('../services/mods/runtime.js')
const { generateCommandSuggestions } = await import('../utils/suggestions/commandSuggestions.js')
const { call: openHelp } = await import('../commands/help/help.js')
const { KeybindingProvider } = await import('../keybindings/KeybindingContext.js')
const { parseBindings } = await import('../keybindings/parser.js')
const describeRoot = await mkdtemp(join(tmpdir(), 'mods-command-react-'))
const describeEntry = join(describeRoot, 'register.ts')
const describeDiagnostics: unknown[] = []
const describeBase = [{ ...local, name: 'sample', description: 'Original', argumentHint: '[old]' }]
const describeRuntime = createModsRuntime({
  services: { commands: () => describeBase },
  onDiagnostic: event => describeDiagnostics.push(event),
})
let describeInstance: Awaited<ReturnType<typeof render>> | undefined
async function helpOutput(
  commands: Command[],
  update?: () => Promise<void>,
  expected = /Browse custom commands:|No custom commands found/,
) {
  const stdout = new TestStdout()
  const stdin = new TestStdin()
  const help = await openHelp(() => {}, { mods: describeRuntime, options: { commands } } as Parameters<typeof openHelp>[1], '')
  const instance = await render(<KeybindingProvider
    bindings={parseBindings([{ context: 'Tabs', bindings: { right: 'tabs:next' } }])}
    pendingChordRef={{ current: null }} pendingChord={null} setPendingChord={() => {}}
    activeContexts={new Set()} registerActiveContext={() => {}} unregisterActiveContext={() => {}}
    handlerRegistryRef={{ current: new Map() }}
  >{help}</KeybindingProvider>, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    stdin.push('\u001b[C')
    const commandsDeadline = performance.now() + 1000
    while (!stripAnsi(stdout.output).includes('Browse default commands:') && performance.now() < commandsDeadline)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.match(stripAnsi(stdout.output), /Browse default commands:/)
    stdout.output = ''
    stdin.push('\u001b[C')
    const deadline = performance.now() + 1000
    while (!stripAnsi(stdout.output).match(expected) && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5))
    if (update) {
      assert.match(stripAnsi(stdout.output), /Described 1/)
      stdout.output = ''
      await update()
      const updateDeadline = performance.now() + 1000
      while (!stripAnsi(stdout.output).includes('Described 2') && performance.now() < updateDeadline)
        await new Promise(resolve => setTimeout(resolve, 5))
    }
    return stripAnsi(stdout.output)
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}
try {
  await writeFile(describeEntry, `let calls=0, revision=0; export function register(on) {
    on('command.describe', {command:'sample'}, async ($,e,next) => {
      calls++; return next({...e,description:'Described '+revision,argumentHint:'[new]',isHidden:revision===0});
    });
    on('tool.call', async ($,e) => {
      if(e.invalidate) {revision++; await $.ui.invalidate('command.describe')}
      return {result:{calls}};
    });
  }`)
  await describeRuntime.reconcile([{ name: 'describe-ui', storageId: 'describe-ui@test', pluginRoot: describeRoot, entrypoints: [describeEntry] }])
  assert.deepEqual(describeDiagnostics, [])
  assert.match(
    await helpOutput(describeBase, undefined, /No custom commands found/),
    /No custom commands found/,
  )
  function CaptureDescribed(): null {
    current = useReplCommands(describeBase, emptyCommands, emptyCommands, 0, false, false, describeRuntime.commands)
    return null
  }
  const emptyCommands: Command[] = []
  describeInstance = await render(React.createElement(CaptureDescribed), {
    stdout: new TestStdout() as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })
  async function waitForDescription(text: string) {
    const deadline = performance.now() + 1000
    while (current[0]?.description !== text && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(current[0]?.description, text, 'React command consumer must receive Worker result')
  }
  await waitForDescription('Described 0')
  assert.equal(current[0]?.argumentHint, '[new]')
  assert.equal(current[0]?.isHidden, true)
  assert.match(await helpOutput(current), /No custom commands found/)
  assert.deepEqual(generateCommandSuggestions('/sam', current), [])
  assert.ok(findUserInvocableCommand('sample', current), 'hidden commands must still run when typed in full')
  for (let index = 0; index < 3; index++) {
    describeInstance.rerender(React.createElement(CaptureDescribed))
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.deepEqual(await describeRuntime.dispatch('tool.call', {}, async () => ({})), { result: { calls: 1 } })
  await describeRuntime.dispatch('tool.call', { invalidate: true }, async () => ({}))
  await waitForDescription('Described 1')
  assert.equal(current[0]?.isHidden, false)
  const suggestions = generateCommandSuggestions('/sam', current)
  assert.equal(suggestions.length, 1)
  const help = await helpOutput(current)
  assert.match(help, /\/sample/)
  assert.match(help, /Described 1/)
  assert.equal(suggestions[0]?.description, 'Described 1')
  assert.equal((suggestions[0]?.metadata as Command).argumentHint, '[new]')
  assert.deepEqual(await describeRuntime.dispatch('tool.call', {}, async () => ({})), { result: { calls: 2 } })
  assert.match(await helpOutput(current, async () => {
    await describeRuntime.dispatch('tool.call', { invalidate: true }, async () => ({}))
  }), /Described 2/, 'an already-open help must observe invalidation')
  assert.deepEqual(await describeRuntime.dispatch('tool.call', {}, async () => ({})), { result: { calls: 3 } })
  assert.deepEqual(describeDiagnostics, [])
} finally {
  describeInstance?.unmount()
  describeInstance?.cleanup()
  await describeRuntime.dispose()
  await rm(describeRoot, { recursive: true, force: true })
}

console.log('useMergedCommands.test.tsx passed')
