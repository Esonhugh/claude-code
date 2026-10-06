import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import React from 'react'
import { ThemeProvider, render } from '../../ink.js'
import type { DOMElement, DOMNode } from '../../ink/dom.js'
import type { FrameEvent } from '../../ink/frame.js'
import instances from '../../ink/instances.js'
import { charInCellAt } from '../../ink/screen.js'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { getTheme } from '../../utils/theme.js'
import PromptInput from './PromptInput.js'

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

test.each([
  { fullscreen: false, goal: false },
  { fullscreen: false, goal: true },
  { fullscreen: true, goal: false },
  { fullscreen: true, goal: true },
])(
  'debug status stays below inline notifications and off the fullscreen overlay: %j',
  async ({ fullscreen, goal }) => {
    process.env.CLAUDE_CODE_NO_FLICKER = fullscreen ? '1' : '0'
    const stdin = new Input(),
      stdout = new Output()
    const baseState = getDefaultAppState()
    const state = {
      ...baseState,
      toolPermissionContext: {
        ...baseState.toolPermissionContext,
        mode: 'bypassPermissions' as const,
      },
      goalStatus: goal
        ? {
            active: true as const,
            id: 'fixture-goal',
            prompt: 'footer',
            iterations: 0,
            setAt: 0,
          }
        : baseState.goalStatus,
    }
    const store = createStore(state)
    const editor = React.createRef<React.ComponentProps<typeof PromptInput>['insertTextRef']['current']>()
    const element = (debug: boolean) => (
      <AppStoreContext value={store}>
        <ThemeProvider initialState="dark">
          <PromptInput
            debug={debug}
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
        </ThemeProvider>
      </AppStoreContext>
    )
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
    async function rows() {
      for (let i = 0; i < 12; i++)
        await new Promise((resolve) => setImmediate(resolve))
      ink.onRender()
      expect(frame).toBeDefined()
      const screen = frame!.screen
      return Array.from({ length: screen.height }, (_, y) =>
        Array.from(
          { length: screen.width },
          (_, x) => charInCellAt(screen, x, y) ?? ' ',
        )
          .join('')
          .trimEnd(),
      )
    }
    function debugStyle(node: DOMNode): DOMElement['textStyles'] | undefined {
      if (node.nodeName === '#text') return undefined
      const text = (child: DOMNode): string =>
        child.nodeName === '#text'
          ? child.nodeValue
          : child.childNodes.map(text).join('')
      if (text(node) === 'Debug' && node.textStyles) return node.textStyles
      return node.childNodes.map(debugStyle).find(Boolean)
    }
    try {
      const enabled = await rows()
      expect(enabled.join('\n')).not.toContain('Debug mode')
      expect(enabled.filter((row) => row.includes('Debug'))).toHaveLength(1)
      const footerIndex = enabled.findIndex((row) =>
        row.includes('bypass permissions'),
      )
      const debugIndex = enabled.findIndex((row) => row.includes('Debug'))
      expect(footerIndex).toBeGreaterThanOrEqual(0)
      if (fullscreen) expect(debugIndex).toBe(footerIndex)
      else expect(debugIndex).toBe(footerIndex + 1)
      if (goal) expect(enabled[debugIndex]).toContain('Goal is set')
      const rootNode = (ink as unknown as { rootNode: DOMElement }).rootNode
      expect(debugStyle(rootNode)).toMatchObject({
        color: getTheme('dark').warning,
      })
      instance.rerender(element(false))
      const disabled = await rows()
      expect(disabled.join('\n')).not.toContain('Debug')
      if (goal) expect(disabled.join('\n')).toContain('Goal is set')
      expect(disabled.length).toBe(
        enabled.length - (!fullscreen && !goal ? 1 : 0),
      )
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  },
)
