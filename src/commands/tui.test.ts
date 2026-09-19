import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tui from './tui.js'
import type { LocalJSXCommandContext } from '../types/command.js'

const childKey = 'TUI_COMMAND_TEST_CHILD'

if (!process.env[childKey]) {
  test.each([
    'switch',
    'default',
    'same',
    'write-error',
    'tasks',
    'override',
    'unavailable',
    'restart-error',
  ])('isolated renderer change: %s', async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'tui-command-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          [childKey]: scenario,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
} else {
  test('isolated switch', async () => {
    const { setOriginalCwd } = await import('../bootstrap/state.js')
    const { initializeFullscreenMode, isFullscreenEnvEnabled } =
      await import('../utils/fullscreen.js')
    const { updateSettingsForSource } =
      await import('../utils/settings/settings.js')
    setOriginalCwd(process.cwd())
    const scenario = process.env[childKey]
    const initial =
      scenario === 'default' || scenario === 'same' ? 'fullscreen' : 'default'
    const requested = scenario === 'default' ? 'default' : 'fullscreen'
    initializeFullscreenMode(initial)
    const settingsPath = join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json')
    if (scenario === 'write-error') {
      mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
      writeFileSync(settingsPath, '{invalid')
    } else {
      expect(
        updateSettingsForSource('userSettings', { theme: 'dark' }).error,
      ).toBeNull()
    }
    if (scenario === 'override') {
      expect(
        updateSettingsForSource('localSettings', { tui: 'default' }).error,
      ).toBeNull()
    }
    const { createCommandInputMessage } = await import('../utils/messages.js')
    const history = [createCommandInputMessage('/tui status')]
    let restarted = false
    mock.module('../utils/tuiRestart.js', () => ({
      canRestartTui: () => scenario !== 'unavailable',
      restartTui: async (messages: typeof history) => {
        expect(messages).toHaveLength(history.length + 1)
        expect(messages[0]).toBe(history[0])
        expect(messages.at(-1)?.type).toBe('system')
        expect(messages.at(-1)?.content).toContain(requested)
        const saved = JSON.parse(readFileSync(settingsPath, 'utf8'))
        expect(saved.tui).toBe(requested)
        expect(saved.theme).toBe('dark')
        expect(isFullscreenEnvEnabled()).toBe(initial === 'fullscreen')
        restarted = true
        if (scenario === 'restart-error') throw new Error('flush failed')
      },
    }))
    const messages: string[] = []
    const command = await tui.load()
    await command.call(
      (message) => messages.push(message ?? ''),
      {
        messages: history,
        getAppState: () => ({
          tasks: scenario === 'tasks' ? { active: { status: 'running' } } : {},
        }),
      } as LocalJSXCommandContext,
      requested,
    )
    expect(restarted).toBe(
      ['switch', 'default', 'restart-error'].includes(scenario!),
    )
    if (scenario === 'same') expect(messages[0]).toContain('already fullscreen')
    if (scenario === 'write-error') {
      expect(messages[0]).toContain('Could not save')
      expect(readFileSync(settingsPath, 'utf8')).toBe('{invalid')
    }
    if (scenario === 'tasks') {
      expect(messages[0]).toContain('background tasks')
      expect(JSON.parse(readFileSync(settingsPath, 'utf8')).tui).toBeUndefined()
    }
    if (scenario === 'override')
      expect(messages[0]).toContain('higher-priority')
    if (scenario === 'unavailable')
      expect(messages[0]).toContain('Automatic restart is unavailable')
    if (scenario === 'restart-error')
      expect(messages[0]).toContain('restart failed: flush failed')
    expect(isFullscreenEnvEnabled()).toBe(initial === 'fullscreen')
  })
}

const originalEnv = { ...process.env }
const globals = globalThis as typeof globalThis & {
  MACRO?: { VERSION: string; BUILD_TIME?: string }
}
const originalMacro = globals.MACRO

beforeEach(() => {
  globals.MACRO = { VERSION: 'test', BUILD_TIME: 'test-build' }
})

afterEach(() => {
  process.env = { ...originalEnv }
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
})

describe('/tui', () => {
  test('explains an environment override instead of claiming a switch', async () => {
    process.env.CLAUDE_CODE_NO_FLICKER = '0'
    const messages: string[] = []
    const command = await tui.load()
    await command.call(
      (message) => messages.push(message ?? ''),
      {} as LocalJSXCommandContext,
      'fullscreen',
    )
    expect(messages[0]).toContain('Cannot switch')
    expect(messages[0]).toContain('CLAUDE_CODE_NO_FLICKER')
    expect(messages[0]).toContain('unset')
    expect(process.env.CLAUDE_CODE_NO_FLICKER).toBe('0')
  })

  test('rejects unsupported modes without changing the renderer', async () => {
    process.env.CLAUDE_CODE_NO_FLICKER = '0'
    const messages: string[] = []
    const command = await tui.load()

    await command.call(
      (message) => messages.push(message ?? ''),
      {} as LocalJSXCommandContext,
      'split',
    )

    expect(messages[0]).toContain('Unknown TUI mode')
    expect(messages[0]).toContain('/tui [status|fullscreen|default]')
    expect(process.env.CLAUDE_CODE_NO_FLICKER).toBe('0')
  })

  test.each(['', 'status'])(
    'reports the renderer, its override and mouse state for %s',
    async (args) => {
      process.env.CLAUDE_CODE_NO_FLICKER = '1'
      process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS = '1'
      delete process.env.CLAUDE_CODE_DISABLE_MOUSE
      const messages: string[] = []
      const command = await tui.load()

      await command.call(
        (message) => messages.push(message ?? ''),
        {} as LocalJSXCommandContext,
        args,
      )

      expect(messages).toHaveLength(1)
      expect(messages[0]).toContain('TUI renderer: fullscreen')
      expect(messages[0]).toContain('CLAUDE_CODE_NO_FLICKER')
      expect(messages[0]).toContain('Mouse: scroll only')
      expect(messages[0]).toContain('Version:')
      expect(messages[0]).toContain('TTY:')
      expect(messages[0]).toContain('DISABLE_MOUSE_CLICKS: on')
      expect(messages[0]).toContain('/tui fullscreen')
      expect(messages[0]).toContain('/tui default')
      expect(messages[0]).toContain('Diff sidebar: use /diff')
      expect(process.env.CLAUDE_CODE_NO_FLICKER).toBe('1')
    },
  )
})
