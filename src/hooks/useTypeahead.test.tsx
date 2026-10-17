import { expect, spyOn, test } from 'bun:test'
import { Readable, Writable } from 'node:stream'
import React, { useState } from 'react'
import type { Tool } from '../Tool.js'
import { render } from '../ink.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
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
