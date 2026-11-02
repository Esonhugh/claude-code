import { expect, test } from 'bun:test'
import { transformAsync } from '@babel/core'
import syntaxTypescript from '@babel/plugin-syntax-typescript'
import reactCompiler from 'babel-plugin-react-compiler'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { dirname, join } from 'node:path'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { render, Text } from '../../ink.js'
import { AppStateProvider, useSetAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'

// The release build runs React Compiler over src (scripts/build.mjs). Compile
// the hook the same way so a render-time store read that the compiler caches
// shows up here as a stale banner.
async function compiledHook(): Promise<{ useSwarmBanner: () => { text: string } | null; cleanup: () => void }> {
  const source = join(dirname(import.meta.path), 'useSwarmBanner.ts')
  const result = await transformAsync(readFileSync(source, 'utf8'), {
    filename: source,
    babelrc: false,
    configFile: false,
    plugins: [
      [syntaxTypescript, { isTSX: false }],
      [reactCompiler, { target: '19', panicThreshold: 'none', environment: { enablePreserveExistingManualUseMemo: true } }],
    ],
  })
  const out = join(dirname(source), `.useSwarmBanner.compiled-${process.pid}.ts`)
  writeFileSync(out, result!.code!)
  const mod = await import(out)
  return { useSwarmBanner: mod.useSwarmBanner, cleanup: () => rmSync(out, { force: true }) }
}

test('the prompt banner shows a name set by /rename right away in the compiled build', async () => {
  const { useSwarmBanner, cleanup } = await compiledHook()
  let setAppState: ((updater: (prev: AppState) => AppState) => void) | undefined
  function Probe(): React.ReactNode {
    setAppState = useSetAppState()
    const banner = useSwarmBanner()
    return <Text>{`banner:${banner?.text ?? 'none'}`}</Text>
  }
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 10, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const instance = await render(
    <AppStateProvider>
      <Probe />
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stripAnsi(output)).toContain('banner:none')
    setAppState!(prev => ({ ...prev, standaloneAgentContext: { ...prev.standaloneAgentContext, name: 'newname' } }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stripAnsi(output)).toContain('banner:newname')
  } finally {
    instance.unmount()
    instance.cleanup()
    cleanup()
  }
})
