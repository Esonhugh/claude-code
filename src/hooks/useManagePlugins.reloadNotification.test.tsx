import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'

test('the "Run /reload-plugins" notification goes away once plugins are reloaded', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'plugin-reload-notification-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  const { render } = await import('../ink.js')
  const { AppStateProvider, useAppStateStore } = await import('../state/AppState.js')
  const { useManagePlugins } = await import('./useManagePlugins.js')

  let store!: ReturnType<typeof useAppStateStore>
  function Probe() {
    store = useAppStateStore()
    useManagePlugins()
    return null
  }
  const setNeedsRefresh = (needsRefresh: boolean) =>
    store.setState(prev => ({ ...prev, plugins: { ...prev.plugins, needsRefresh } }))
  const pending = () => {
    const { current, queue } = store.getState().notifications
    return [current, ...queue].some(n => n?.key === 'plugin-reload-pending')
  }

  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  stdout.resume()
  const instance = await render(
    <AppStateProvider>
      <Probe />
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    setNeedsRefresh(true)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(pending()).toBe(true)

    // 官方 2.1.329：needsRefresh 归零时移除 plugin-reload-pending，
    // 关闭 /plugin 自动 reload 后不再提示手动 /reload-plugins。
    setNeedsRefresh(false)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(pending()).toBe(false)
  } finally {
    instance.unmount()
    instance.cleanup()
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(configDir, { recursive: true, force: true })
  }
})
