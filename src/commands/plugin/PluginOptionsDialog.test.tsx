import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { Readable, Writable } from 'node:stream'
import React, { useEffect, useRef } from 'react'
import stripAnsi from 'strip-ansi'
import { render, useStdin } from '../../ink.js'
import { KeybindingProvider } from '../../keybindings/KeybindingContext.js'
import { DEFAULT_BINDINGS } from '../../keybindings/defaultBindings.js'
import { parseBindings } from '../../keybindings/parser.js'
import type { ParsedKeystroke } from '../../keybindings/types.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import * as settings from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'

let savedSettings: SettingsJson = {}
const secureStorage = {
  read: mock(() => ({})),
  update: mock(() => ({ success: true })),
}
mock.module('../../utils/secureStorage/index.js', () => ({
  getSecureStorage: () => secureStorage,
}))

const {
  clearPluginOptionsCache,
  getUnconfiguredOptions,
  loadPluginOptions,
  savePluginOptions,
} = await import('../../utils/plugins/pluginOptionsStorage.js')

const choice = {
  type: 'string' as const,
  title: 'Project instructions',
  description: 'Choose instruction files',
  default: 'claude-md-or-agents-md',
  options: [
    'claude-md',
    'claude-md-or-agents-md',
    'claude-md-and-agents-md',
    'managed-only',
  ],
}
const { PluginOptionsDialog } = await import('./PluginOptionsDialog.js')

class Output extends Writable {
  columns = 100
  rows = 35
  isTTY = false
  output = ''
  _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.output += chunk.toString()
    done()
  }
}
class Input extends Readable {
  isTTY = true
  isRaw = false
  _read() {}
  setRawMode(value: boolean) {
    this.isRaw = value
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}
function Keys({ children }: { children: React.ReactNode }) {
  const { setRawMode } = useStdin()
  useEffect(() => {
    setRawMode(true)
    return () => setRawMode(false)
  }, [setRawMode])
  const pending = useRef<ParsedKeystroke[] | null>(null)
  const registry = useRef(new Map())
  return (
    <KeybindingProvider
      bindings={parseBindings(DEFAULT_BINDINGS)}
      pendingChordRef={pending}
      pendingChord={null}
      setPendingChord={value => {
        pending.current = value
      }}
      activeContexts={new Set()}
      registerActiveContext={() => {}}
      unregisterActiveContext={() => {}}
      handlerRegistryRef={registry}
    >
      {children}
    </KeybindingProvider>
  )
}
async function mountDialog(
  props: Partial<React.ComponentProps<typeof PluginOptionsDialog>> = {},
) {
  const stdout = new Output()
  const stdin = new Input()
  const onSave = mock(() => {})
  const onCancel = mock(() => {})
  const instance = await render(
    <Keys>
      <PluginOptionsDialog
        title="Configure agents-md"
        subtitle="Plugin options"
        configSchema={schema}
        onSave={onSave}
        onCancel={onCancel}
        {...props}
      />
    </Keys>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  await new Promise(resolve => setTimeout(resolve, 40))
  return {
    onSave,
    onCancel,
    text: () => stripAnsi(stdout.output),
    async input(value: string) {
      stdin.push(value)
      // Ink buffers a lone Escape for NORMAL_TIMEOUT (50ms).
      await new Promise(resolve => setTimeout(resolve, 80))
    },
    close() {
      instance.unmount()
      instance.cleanup()
    },
  }
}

const schema = { instructionFiles: choice }
const plugin: LoadedPlugin = {
  name: 'agents-md',
  path: '/plugins/agents-md',
  source: 'agents-md@inline',
  repository: 'agents-md@inline',
  manifest: { name: 'agents-md', userConfig: schema },
}

beforeEach(() => {
  savedSettings = {}
  secureStorage.read.mockClear()
  secureStorage.update.mockClear()
  spyOn(settings, 'getSettings_DEPRECATED').mockImplementation(
    () => savedSettings,
  )
  spyOn(settings, 'updateSettingsForSource').mockImplementation(
    (_source, values) => {
      savedSettings = values
      return { error: null }
    },
  )
  clearPluginOptionsCache()
})
afterEach(() => mock.restore())

describe('plugin option configuration', () => {
  test('renders declared choices in order and saves the selected value after keyboard navigation', async () => {
    const view = await mountDialog({
      onSave: values => savePluginOptions(plugin.source, values, schema),
    })
    try {
      for (const [index, option] of choice.options.entries()) {
        expect(view.text()).toContain(`${index + 1}. ${option}`)
      }
      await view.input('\u001b[B')
      await view.input('\r')
      expect(loadPluginOptions(plugin.source)).toEqual({
        instructionFiles: 'claude-md-and-agents-md',
      })
    } finally {
      view.close()
    }
  })

  test.each([
    [undefined, choice.default],
    ['removed-choice', choice.default],
    ['managed-only', 'managed-only'],
  ])(
    'preselects the effective value for %s and ignores arbitrary text',
    async (initial, expected) => {
      const view = await mountDialog({
        initialValues:
          initial === undefined ? {} : { instructionFiles: initial },
      })
      try {
        await view.input('unlisted')
        await view.input('\r')
        expect(view.onSave).toHaveBeenCalledTimes(1)
        expect(view.onSave).toHaveBeenCalledWith({
          instructionFiles: expected,
        })
      } finally {
        view.close()
      }
    },
  )

  test('keeps picker selection across Tab, restores text input on the next field, and preserves saved secrets', async () => {
    const view = await mountDialog({
      configSchema: {
        ...schema,
        note: { type: 'string', title: 'Note', description: '' },
        token: {
          type: 'string',
          title: 'Token',
          description: '',
          sensitive: true,
          required: true,
        },
      },
      initialValues: {
        instructionFiles: 'claude-md',
        token: 'test-secret-never-render',
      },
    })
    try {
      await view.input('\u001b[B')
      await view.input('\t')
      await view.input('hello')
      await view.input('\r')
      expect(view.text()).not.toContain('test-secret-never-render')
      await view.input('\r')
      expect(view.onSave).toHaveBeenCalledWith({
        instructionFiles: choice.default,
        note: 'hello',
      })
    } finally {
      view.close()
    }
  })

  test('Escape cancels the picker without saving', async () => {
    const view = await mountDialog()
    try {
      await view.input('\u001b')
      expect(view.onCancel).toHaveBeenCalledTimes(1)
      expect(view.onSave).not.toHaveBeenCalled()
    } finally {
      view.close()
    }
  })

  test('shows validation errors without saving and allows correction', async () => {
    const view = await mountDialog({
      configSchema: {
        attempts: {
          type: 'number',
          title: 'Attempts',
          description: '',
          required: true,
        },
      },
    })
    try {
      await view.input('\r')
      expect(view.onSave).not.toHaveBeenCalled()
      expect(view.text()).toContain('Attempts is required but not provided')
      await view.input('3')
      await view.input('\r')
      expect(view.onSave).toHaveBeenCalledWith({ attempts: 3 })
    } finally {
      view.close()
    }
  })

  test('uses defaults for missing and stale choices when deciding whether configuration is required', () => {
    const requiredPlugin = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        userConfig: {
          instructionFiles: { ...choice, required: true },
        },
      },
    }
    expect(getUnconfiguredOptions(requiredPlugin)).toEqual({})
    savedSettings = {
      pluginConfigs: {
        [plugin.source]: { options: { instructionFiles: 'removed-choice' } },
      },
    }
    clearPluginOptionsCache()
    expect(getUnconfiguredOptions(requiredPlugin)).toEqual({})
    const noDefault = {
      ...requiredPlugin,
      manifest: {
        ...requiredPlugin.manifest,
        userConfig: {
          instructionFiles: { ...choice, default: undefined, required: true },
        },
      },
    }
    expect(Object.keys(getUnconfiguredOptions(noDefault))).toEqual([
      'instructionFiles',
    ])
  })

  test('refuses an invalid choice before either settings or secure storage is touched', () => {
    expect(() =>
      savePluginOptions(
        plugin.source,
        { instructionFiles: 'removed-choice' },
        schema,
      ),
    ).toThrow('Project instructions must be one of')
    expect(savedSettings).toEqual({})
    expect(secureStorage.read).not.toHaveBeenCalled()
    expect(secureStorage.update).not.toHaveBeenCalled()
  })
})
