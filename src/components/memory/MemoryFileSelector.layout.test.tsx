import { afterAll, beforeAll, expect, test } from 'bun:test'
import React, { Suspense } from 'react'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'os'
import { join } from 'path'
import stripAnsi from 'strip-ansi'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { MemoryFileSelector } from './MemoryFileSelector.js'

const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
const AUTO_MEMORY_ENV = ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_REMOTE']
const previousEnv = AUTO_MEMORY_ENV.map(name => process.env[name])
let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'memory-selector-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  for (const name of AUTO_MEMORY_ENV) delete process.env[name]
  writeFileSync(join(configDir, 'CLAUDE.md'), '# user\n')
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  AUTO_MEMORY_ENV.forEach((name, i) => {
    if (previousEnv[i] === undefined) delete process.env[name]
    else process.env[name] = previousEnv[i]
  })
  rmSync(configDir, { recursive: true, force: true })
})

test('/memory lists toggles and instruction files like official 2.1.311', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const selected: string[] = []
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <Suspense fallback={null}>
          <MemoryFileSelector onSelect={path => selected.push(path)} onCancel={() => {}} />
        </Suspense>
      </KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  const settle = () => new Promise(resolve => setTimeout(resolve, 100))
  const frame = () => stripAnsi(output).split('Auto-memory').at(-1) ?? ''
  try {
    for (let i = 0; i < 50 && !output.includes('instructions'); i++) await settle()
    expect(frame()).toMatch(/^\s+true\n/)
    expect(frame()).toMatch(/[❯>] User instructions\s+Saved in ~\/\.claude\/CLAUDE\.md/)
    expect(frame()).toMatch(/Project instructions\s+(Checked in at|Saved in) \.\/CLAUDE\.md/)
    expect(frame()).toContain('Open auto-memory folder')
    expect(stripAnsi(output)).not.toMatch(/\d\. (User|Project)/)
    expect(stripAnsi(output)).not.toContain('Auto-dream')

    // Up from the first file focuses the toggle; Enter turns auto-memory off.
    stdin.write('\u001B[A')
    await settle()
    expect(stripAnsi(output).split('Auto-memory').at(-2)).toMatch(/[❯>] $/)
    expect(frame()).not.toMatch(/[❯>] /)
    stdin.write('\r')
    await settle()
    expect(frame()).toMatch(/^\s+false\n/)
    expect(frame()).not.toContain('Open auto-memory folder')
  } finally {
    instance.unmount()
  }
})
