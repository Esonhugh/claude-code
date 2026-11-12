import { afterAll, beforeAll, expect, test } from 'bun:test'
import React from 'react'
import { mkdtempSync, rmSync } from 'fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LocalJSXCommandContext } from '../../commands.js'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
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
