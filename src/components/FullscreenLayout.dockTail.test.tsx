import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import React from 'react'
import { Box, Text, ThemeProvider, render } from '../ink.js'
import type { FrameEvent } from '../ink/frame.js'
import instances from '../ink/instances.js'
import { charInCellAt, cellAt } from '../ink/screen.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import PromptInput from './PromptInput/PromptInput.js'

const envKeys = [
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_NO_FLICKER',
]
let configRoot: string | undefined
let savedEnvironment: (string | undefined)[] = []

beforeEach(async () => {
  savedEnvironment = envKeys.map((key) => process.env[key])
  configRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'prompt-debug-footer-')),
  )
  process.env.HOME = configRoot
  process.env.CLAUDE_CONFIG_DIR = join(configRoot, 'config')
  process.env.XDG_CONFIG_HOME = join(configRoot, 'xdg-config')
  process.env.XDG_CACHE_HOME = join(configRoot, 'xdg-cache')
  process.env.XDG_STATE_HOME = join(configRoot, 'xdg-state')
  process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  resetSettingsCache()
})

afterEach(async () => {
  try {
    if (configRoot) await rm(configRoot, { recursive: true, force: true })
  } finally {
    configRoot = undefined
    resetSettingsCache()
    envKeys.forEach((key, index) => {
      if (savedEnvironment[index] === undefined) delete process.env[key]
      else process.env[key] = savedEnvironment[index]
    })
  }
})

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
  columns = 160
  rows = 40
  isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    done()
  }
}

import { FullscreenLayout } from './FullscreenLayout.js'
import { usePromptOverlayAnchor } from '../context/promptOverlayContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'

for (const leading of [false, true])
  test(`dock tail fills only a prompt margin at the bottom origin (leading=${leading})`, async () => {
    process.env.CLAUDE_CODE_NO_FLICKER = '1'
    const stdin = new Input(),
      stdout = new Output()
    const state = getDefaultAppState(),
      store = createStore(state)
    const editor =
      React.createRef<
        React.ComponentProps<typeof PromptInput>['insertTextRef']['current']
      >()
    function Dock() {
      const { columns } = useTerminalSize()
      return <Text>DOCK:{columns}</Text>
    }
    function element(open: boolean) {
      return (
        <AppStoreContext value={store}>
          <ThemeProvider initialState="dark">
            <Box
              width={stdout.columns}
              height={stdout.rows}
              flexDirection="column"
            >
              <FullscreenLayout
                scrollable={<Text>TRANSCRIPT</Text>}
                dockWidth={30}
                dockPane={open ? <Dock /> : undefined}
                bottom={
                  <>
                    {leading && <Text>SPINNER</Text>}
                    <PromptInput
                      debug={false}
                      ideSelection={undefined}
                      toolPermissionContext={state.toolPermissionContext}
                      setToolPermissionContext={() => {}}
                      apiKeyStatus="valid"
                      commands={[]}
                      agents={[]}
                      enableLocalIOCompletions={false}
                      isLoading={false}
                      isAssistantResponding={false}
                      verbose={false}
                      messages={[]}
                      onAutoUpdaterResult={() => {}}
                      autoUpdaterResult={null}
                      input=""
                      onInputChange={() => {}}
                      mode="prompt"
                      onModeChange={() => {}}
                      stashedPrompt={undefined}
                      setStashedPrompt={() => {}}
                      submitCount={0}
                      onShowMessageSelector={() => {}}
                      mcpClients={[]}
                      pastedContents={{}}
                      setPastedContents={() => {}}
                      vimMode="INSERT"
                      setVimMode={() => {}}
                      showBashesDialog={false}
                      setShowBashesDialog={() => {}}
                      onExit={() => {}}
                      getToolUseContext={() => {
                        throw new Error('This fixture never executes a query')
                      }}
                      onSubmit={async () => {
                        throw new Error('This fixture never submits')
                      }}
                      isSearchingHistory={false}
                      setIsSearchingHistory={() => {}}
                      helpOpen={false}
                      setHelpOpen={() => {}}
                      insertTextRef={editor}
                    />
                  </>
                }
              />
            </Box>
          </ThemeProvider>
        </AppStoreContext>
      )
    }
    let frame: FrameEvent['frame']
    const instance = await render(element(true), {
      stdin: stdin as never,
      stdout: stdout as never,
      patchConsole: false,
      exitOnCtrlC: false,
      onFrame: (event) => {
        frame = event.frame
      },
    })
    const ink = instances.get(stdout as never)!
    function visible() {
      return Array.from({ length: frame!.screen.height }, (_, y) =>
        Array.from(
          { length: frame!.screen.width },
          (_, x) => charInCellAt(frame!.screen, x, y) ?? ' ',
        ).join(''),
      )
    }
    async function settle() {
      for (let i = 0; i < 14; i++)
        await new Promise((resolve) => setImmediate(resolve))
      ink.onRender()
      expect(frame).toBeDefined()
    }
    try {
      for (const columns of [160, 120]) {
        stdout.columns = columns
        stdout.emit('resize')
        instance.rerender(element(true))
        await settle()
        const rows = visible(),
          promptRow = rows.findIndex((row) => row.trimStart().startsWith('❯'))
        expect(promptRow).toBeGreaterThan(2)
        expect(rows[promptRow - 1]!.trim()).toBe('─'.repeat(columns))
        const gap = promptRow - 2,
          x = columns - 30
        expect(charInCellAt(frame!.screen, x, gap)).toBe(leading ? ' ' : '│')
        if (!leading) {
          expect(rows[gap]!.slice(0, x)).toContain('/effort')
          expect(rows[gap]!.slice(x)).not.toContain('/effort')
          expect(cellAt(frame!.screen, x, gap)?.styleId).toEqual(
            cellAt(frame!.screen, x, gap - 1)?.styleId,
          )
          expect(cellAt(frame!.screen, x + 1, gap)?.styleId).toEqual(
            cellAt(frame!.screen, x + 1, gap - 1)?.styleId,
          )
        } else expect(rows[gap - 1]).toContain('SPINNER')
      }
      instance.rerender(element(false))
      await settle()
      const rows = visible(),
        promptRow = rows.findIndex((row) => row.trimStart().startsWith('❯'))
      expect(
        charInCellAt(frame!.screen, stdout.columns - 30, promptRow - 2),
      ).not.toBe('│')
      expect(rows.some((row) => row.includes('DOCK:'))).toBe(false)
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  })

test('dock tail follows measured margin changes and disappears when its anchor unmounts', async () => {
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  const stdin = new Input(),
    stdout = new Output()
  function Composer({ margin }: { margin: number }) {
    const anchor = usePromptOverlayAnchor()
    return (
      <Box ref={anchor} marginTop={margin}>
        <Text>ANCHORED_COMPOSER</Text>
      </Box>
    )
  }
  const element = (margin: number, anchored = true) => (
    <ThemeProvider initialState="dark">
      <Box width={160} height={40} flexDirection="column">
        <FullscreenLayout
          scrollable={<Text>TRANSCRIPT</Text>}
          dockWidth={30}
          dockPane={<Text>DOCK</Text>}
          bottom={
            anchored ? (
              <Composer margin={margin} />
            ) : (
              <Box marginTop={margin}>
                <Text>REPLACEMENT</Text>
              </Box>
            )
          }
        />
      </Box>
    </ThemeProvider>
  )
  let frame: FrameEvent['frame']
  const instance = await render(element(3), {
    stdin: stdin as never,
    stdout: stdout as never,
    patchConsole: false,
    exitOnCtrlC: false,
    onFrame: (event) => {
      frame = event.frame
    },
  })
  const ink = instances.get(stdout as never)!
  async function settle() {
    for (let i = 0; i < 14; i++)
      await new Promise((resolve) => setImmediate(resolve))
    ink.onRender()
    expect(frame).toBeDefined()
  }
  function row(text: string) {
    return Array.from({ length: frame!.screen.height }, (_, y) =>
      Array.from(
        { length: frame!.screen.width },
        (_, x) => charInCellAt(frame!.screen, x, y) ?? ' ',
      ).join(''),
    ).findIndex((line) => line.includes(text))
  }
  try {
    for (const margin of [3, 0, 2, 1]) {
      instance.rerender(element(margin))
      await settle()
      const composer = row('ANCHORED_COMPOSER')
      expect(composer).toBeGreaterThanOrEqual(margin)
      for (let y = composer - margin; y < composer; y++)
        expect(charInCellAt(frame!.screen, 130, y)).toBe('│')
      expect(charInCellAt(frame!.screen, 130, composer)).not.toBe('│')
    }
    instance.rerender(element(2, false))
    await settle()
    const replacement = row('REPLACEMENT')
    expect(replacement).toBeGreaterThan(1)
    for (let y = replacement - 2; y < replacement; y++)
      expect(charInCellAt(frame!.screen, 130, y)).not.toBe('│')
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
