import { expect, spyOn, test } from 'bun:test'
import { Readable, Writable } from 'node:stream'
import React, { useState } from 'react'
import type { Tool } from '../Tool.js'
import { render } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import * as shellCompletion from '../utils/bash/shellCompletion.js'
import * as settings from '../utils/settings/settings.js'
import * as files from './fileSuggestions.js'
import { useTypeahead } from './useTypeahead.js'

type Props = Parameters<typeof useTypeahead>[0]

class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

class Output extends Writable {
  columns = 80
  rows = 24
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    done()
  }
}

function appTool(app: string): Tool {
  const name = `mcp__codex_apps__${app}__search`
  return {
    name,
    mcpInfo: { serverName: 'codex_apps', toolName: name },
    connectorInfo: { id: `${app}-id`, name: app },
  } as Tool
}

test.each(['@codex-app:', '@'])(
  '%s excludes disabled Apps retained in the MCP catalog',
  async input => {
    const settingsSpy = spyOn(
      settings,
      'getSettingsForSource',
    ).mockImplementation(source =>
      source === 'userSettings' ? { disabledCodexApps: ['gmail-id'] } : null,
    )
    const refreshSpy = spyOn(
      files,
      'startBackgroundCacheRefresh',
    ).mockImplementation(() => {})
    const filesSpy = spyOn(files, 'generateFileSuggestions').mockResolvedValue(
      [],
    )
    let instance: Awaited<ReturnType<typeof render>> | undefined
    try {
      const state = getDefaultAppState()
      const tools = [appTool('github'), appTool('gmail')]
      const store = createStore({ ...state, mcp: { ...state.mcp, tools } })
      const commands: Props['commands'] = []
      const agents: Props['agents'] = []
      let result: ReturnType<typeof useTypeahead> | undefined

      function Probe() {
        const [suggestionsState, setSuggestionsState] = useState<
          Props['suggestionsState']
        >({
          suggestions: [],
          selectedSuggestion: -1,
        })
        result = useTypeahead({
          input,
          cursorOffset: input.length,
          mode: 'prompt',
          commands,
          agents,
          suggestionsState,
          setSuggestionsState,
          onInputChange: () => {},
          onSubmit: () => {},
          setCursorOffset: () => {},
          markAccepted: () => {},
        })
        return null
      }

      instance = await render(
        <AppStoreContext value={store}>
          <Probe />
        </AppStoreContext>,
        {
          stdin: new Input() as unknown as NodeJS.ReadStream,
          stdout: new Output() as unknown as NodeJS.WriteStream,
          patchConsole: false,
          exitOnCtrlC: false,
        },
      )
      const deadline = Date.now() + 2000
      while (
        !result?.suggestions.some(item => item.id === 'codex-app-github') &&
        Date.now() < deadline
      ) {
        await new Promise(resolve => setImmediate(resolve))
      }

      expect(store.getState().mcp.tools).toBe(tools)
      expect(
        store.getState().mcp.tools.map(tool => tool.connectorInfo?.id),
      ).toEqual(['github-id', 'gmail-id'])
      expect(result?.suggestions.map(item => item.displayText)).toEqual([
        'codex-app:github',
      ])
      expect(result?.suggestionType).toBe('file')
    } finally {
      instance?.unmount()
      instance?.cleanup()
      filesSpy.mockRestore()
      refreshSpy.mockRestore()
      settingsSpy.mockRestore()
    }
  },
)

test('Tab in bash mode runs shell completion with no suggestions shown', async () => {
  const completionSpy = spyOn(
    shellCompletion,
    'getShellCompletions',
  ).mockResolvedValue([
    {
      id: './qt-demo/',
      displayText: './qt-demo/',
      metadata: { completionType: 'file', inputSnapshot: 'ls ./qt-de' },
    },
  ])
  const stdin = new Input()
  const changes: string[] = []
  let instance: Awaited<ReturnType<typeof render>> | undefined
  try {
    const store = createStore(getDefaultAppState())
    const input = 'ls ./qt-de'

    function Probe() {
      const [suggestionsState, setSuggestionsState] = useState<
        Props['suggestionsState']
      >({
        suggestions: [],
        selectedSuggestion: -1,
      })
      useTypeahead({
        input,
        cursorOffset: input.length,
        mode: 'bash',
        commands: [],
        agents: [],
        suggestionsState,
        setSuggestionsState,
        onInputChange: value => changes.push(value),
        onSubmit: () => {},
        setCursorOffset: () => {},
        markAccepted: () => {},
      })
      return null
    }

    instance = await render(
      <AppStoreContext value={store}>
        <Probe />
      </AppStoreContext>,
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: new Output() as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    stdin.push('\t')
    const deadline = Date.now() + 2000
    while (changes.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(completionSpy).toHaveBeenCalledTimes(1)
    expect(completionSpy.mock.calls[0]?.slice(0, 2)).toEqual([
      input,
      input.length,
    ])
    expect(changes).toEqual(['ls ./qt-demo/'])
  } finally {
    instance?.unmount()
    instance?.cleanup()
    completionSpy.mockRestore()
  }
})

test('Tab in bash mode of a remote session does not run local shell completion', async () => {
  const completionSpy = spyOn(
    shellCompletion,
    'getShellCompletions',
  ).mockResolvedValue([
    {
      id: './qt-demo/',
      displayText: './qt-demo/',
      metadata: { completionType: 'file', inputSnapshot: 'ls ./qt-de' },
    },
  ])
  const stdin = new Input()
  const changes: string[] = []
  let instance: Awaited<ReturnType<typeof render>> | undefined
  try {
    const store = createStore(getDefaultAppState())
    const input = 'ls ./qt-de'

    function Probe() {
      const [suggestionsState, setSuggestionsState] = useState<
        Props['suggestionsState']
      >({
        suggestions: [],
        selectedSuggestion: -1,
      })
      useTypeahead({
        input,
        cursorOffset: input.length,
        mode: 'bash',
        commands: [],
        agents: [],
        suggestionsState,
        setSuggestionsState,
        onInputChange: value => changes.push(value),
        onSubmit: () => {},
        setCursorOffset: () => {},
        markAccepted: () => {},
        enableLocalIOCompletions: false,
        remoteFileSuggestionProvider: async () => ({ items: [], incomplete: false }),
      })
      return null
    }

    instance = await render(
      <AppStoreContext value={store}>
        <Probe />
      </AppStoreContext>,
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: new Output() as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    stdin.push('\t')
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(completionSpy).not.toHaveBeenCalled()
    expect(changes).toEqual([])
  } finally {
    instance?.unmount()
    instance?.cleanup()
    completionSpy.mockRestore()
  }
})

function renderModProbe(
  initial: string,
  modAutocomplete: NonNullable<Props['modAutocomplete']>,
) {
  const stdin = new Input()
  const changes: string[] = []
  const cursors: number[] = []
  const view: {
    result?: ReturnType<typeof useTypeahead>
    setInput?: (value: string) => void
  } = {}
  function Probe() {
    const [input, setInput] = useState(initial)
    const [suggestionsState, setSuggestionsState] = useState<
      Props['suggestionsState']
    >({ suggestions: [], selectedSuggestion: -1 })
    view.setInput = setInput
    view.result = useTypeahead({
      input,
      cursorOffset: input.length,
      mode: 'prompt',
      commands: [],
      agents: [],
      suggestionsState,
      setSuggestionsState,
      onInputChange: value => changes.push(value),
      onSubmit: () => {},
      setCursorOffset: value => cursors.push(value),
      markAccepted: () => {},
      modAutocomplete,
    })
    return null
  }
  const store = createStore(getDefaultAppState())
  const rendered = render(
    <AppStoreContext value={store}>
      <KeybindingSetup>
        <Probe />
      </KeybindingSetup>
    </AppStoreContext>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: new Output() as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  return { stdin, changes, cursors, view, rendered }
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('Mod prompt.autocomplete rows show for a plain token and Tab inserts the pick', async () => {
  const calls: { token: string; start: number }[] = []
  const probe = renderModProbe('say %o', async input => {
    calls.push({ token: input.token, start: input.start })
    return {
      suggestions: [
        { text: 'percent-one', label: '%one', description: 'first' },
        { text: 'percent-two' },
      ],
    }
  })
  const instance = await probe.rendered
  try {
    await waitFor(() => (probe.view.result?.suggestions.length ?? 0) > 0)
    expect(calls).toEqual([{ token: '%o', start: 4 }])
    expect(
      probe.view.result?.suggestions.map(item => [
        item.displayText,
        item.description,
      ]),
    ).toEqual([
      ['%one', 'first'],
      ['percent-two', undefined],
    ])
    expect(probe.view.result?.selectedSuggestion).toBe(-1)
    // The Autocomplete keybinding context registers in an effect after the
    // rows render; a Tab before that is ignored, as it is for native rows.
    await waitFor(() => {
      if (probe.changes.length === 0) probe.stdin.push('\t')
      return probe.changes.length > 0
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(probe.changes).toEqual(['say percent-one'])
    expect(probe.cursors).toEqual([15])
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})

test('Mod rows follow @-file rows', async () => {
  const refreshSpy = spyOn(files, 'startBackgroundCacheRefresh').mockImplementation(() => {})
  const filesSpy = spyOn(files, 'generateFileSuggestions').mockResolvedValue([
    { id: 'file-modfile.md', displayText: 'modfile.md' },
  ])
  const probe = renderModProbe('@mod', async () => ({
    suggestions: [{ text: '@modfile', description: 'mod row' }],
  }))
  const instance = await probe.rendered
  try {
    await waitFor(() => (probe.view.result?.suggestions.length ?? 0) > 1)
    expect(probe.view.result?.suggestions.map(item => item.displayText)).toEqual([
      'modfile.md',
      '@modfile',
    ])
  } finally {
    instance.unmount()
    instance.cleanup()
    filesSpy.mockRestore()
    refreshSpy.mockRestore()
  }
})

test('fast typing asks once for the latest token and drops a superseded answer', async () => {
  const asked: string[] = []
  const signals: AbortSignal[] = []
  const answers: ((rows: { text: string }[]) => void)[] = []
  const probe = renderModProbe('%', (input, signal) => {
    asked.push(input.token)
    signals.push(signal)
    return new Promise(resolve =>
      answers.push(rows => resolve({ suggestions: rows })),
    )
  })
  const instance = await probe.rendered
  try {
    probe.view.setInput?.('%o')
    probe.view.setInput?.('%on')
    await waitFor(() => asked.length > 0)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(asked).toEqual(['%on'])
    probe.view.setInput?.('%one')
    await waitFor(() => asked.length > 1)
    expect(asked).toEqual(['%on', '%one'])
    expect(signals[0]?.aborted).toBe(true)
    answers[0]?.([{ text: 'stale' }])
    answers[1]?.([{ text: 'fresh' }])
    await waitFor(() => (probe.view.result?.suggestions.length ?? 0) > 0)
    expect(probe.view.result?.suggestions.map(item => item.displayText)).toEqual(['fresh'])
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
