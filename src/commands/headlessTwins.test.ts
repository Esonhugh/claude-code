import { afterEach, expect, test } from 'bun:test'
import { getIsNonInteractiveSession, setIsInteractive } from '../bootstrap/state.js'
import { findCommand, getCommands } from '../commands.js'

const wasInteractive = !getIsNonInteractiveSession()

afterEach(() => {
  setIsInteractive(wasInteractive)
})

// Official 2.1.311 ships text twins of these commands for -p and the SDK.
test.each([
  ['model', '<model>'],
  ['config', 'key=value'],
  ['rename', '[name]'],
  ['color', '[red|blue|green|yellow|purple|orange|pink|cyan|default]'],
])('-p "/%s" resolves to a text command', async (name, argumentHint) => {
  setIsInteractive(false)
  const command = findCommand(name, await getCommands(process.cwd()))
  expect(command?.type).toBe('local')
  expect(command?.type === 'local' && command.supportsNonInteractive).toBe(true)
  expect(command?.argumentHint).toBe(argumentHint)
})

test('effort twin keeps the interactive level list', async () => {
  setIsInteractive(false)
  const command = findCommand('effort', await getCommands(process.cwd()))
  expect(command?.type).toBe('local')
  expect(command?.argumentHint).toStartWith('<')
  expect(command?.argumentHint).toContain('minimal')
})

test('/name is an alias of /rename', async () => {
  setIsInteractive(false)
  expect(findCommand('name', await getCommands(process.cwd()))?.name).toBe('rename')
})

test('interactive sessions keep the dialog commands', async () => {
  setIsInteractive(true)
  const commands = await getCommands(process.cwd())
  for (const name of ['model', 'effort', 'config', 'rename', 'color']) {
    expect(findCommand(name, commands)?.type).toBe('local-jsx')
  }
})

test('reload commands run headless', async () => {
  setIsInteractive(false)
  const commands = await getCommands(process.cwd())
  for (const name of ['reload-plugins', 'reload-skills']) {
    const command = findCommand(name, commands)
    expect(command?.type === 'local' && command.supportsNonInteractive).toBe(true)
  }
})

test('effort twin sets and reports the level as text', async () => {
  const { call } = await import('./effort/effortNonInteractive.js')
  let effortValue: string | undefined
  const context = {
    getAppState: () => ({ effortValue }),
    setAppState: (f: (prev: object) => { effortValue?: string }) => {
      effortValue = f({}).effortValue
    },
  } as never
  const result = await call('high', context)
  expect(result).toEqual({ type: 'text', value: expect.stringContaining('high') })
  expect(effortValue).toBe('high')
})
