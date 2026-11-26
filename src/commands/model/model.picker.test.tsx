import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import React from 'react'
import { mkdtempSync, rmSync } from 'fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LocalJSXCommandContext } from '../../commands.js'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import * as modelSwitchHooks from '../../utils/model/modelSwitchHooks.js'
import * as promptCacheFacts from '../../utils/promptCacheFacts.js'
import { call } from './model.js'

const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'model-picker-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

test('/model: an Enter right after a digit pick does not pick the focused row too', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 40, isTTY: false })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const done: string[] = []
  const models: Array<string | null> = []
  const element = await call(
    result => { done.push(result ?? '') },
    { messages: [], abortController: new AbortController(), getAppState: () => getDefaultAppState() } as unknown as LocalJSXCommandContext,
    '',
  )
  const instance = await render(
    <AppStateProvider
      onChangeAppState={({ newState, oldState }) => {
        if (newState.mainLoopModel !== oldState.mainLoopModel) models.push(newState.mainLoopModel)
      }}
    >
      <KeybindingSetup>{element}</KeybindingSetup>
    </AppStateProvider>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false },
  )
  const settle = () => new Promise(resolve => setTimeout(resolve, 100))
  try {
    await settle()
    // Option 1 is Default (model null); the Enter must not reach it.
    stdin.write('2')
    stdin.write('\r')
    await settle()
    await settle()
    expect(done).toHaveLength(1)
    expect(models).toHaveLength(1)
    expect(models[0]).not.toBeNull()
  } finally {
    instance.unmount()
  }
})

test.each([
  [true, 1],
  [false, 0],
] as const)('/model <name>: a PreModelSwitch allow (skipConfirm %p) decides the warm-cache prompt, and hook messages follow the result like 2.1.329', async (skipConfirm, finished) => {
  const check = spyOn(modelSwitchHooks, 'checkModelSwitch').mockResolvedValue({
    decision: 'proceed',
    skipConfirm,
    messages: ['costs more'],
  })
  const cache = spyOn(promptCacheFacts, 'getPromptCacheFacts').mockReturnValue({
    promptCacheLikelyExpired: false,
  } as never)
  const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 40, isTTY: false })
  let screen = ''
  stdout.on('data', chunk => { screen += String(chunk) })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const done: string[] = []
  const element = await call(
    result => { done.push(result ?? '') },
    { messages: [], abortController: new AbortController(), getAppState: () => getDefaultAppState() } as unknown as LocalJSXCommandContext,
    'haiku',
  )
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>{element}</KeybindingSetup>
    </AppStateProvider>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false },
  )
  try {
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(done).toHaveLength(finished)
    if (skipConfirm) expect(done[0]).toEndWith('\ncosts more')
    else expect(screen).toContain('Switch model?')
  } finally {
    instance.unmount()
    check.mockRestore()
    cache.mockRestore()
  }
})
