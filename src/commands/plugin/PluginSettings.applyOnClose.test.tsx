import { expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'

mock.module('./ManagePlugins.js', () => ({
  // 等价于 Installed 页里 Disable/Update/Uninstall 成功后的三步。
  ManagePlugins({
    setResult,
    setViewState,
    onManageComplete,
  }: {
    setResult: (result: string) => void
    setViewState: (state: { type: 'menu' }) => void
    onManageComplete: () => void
  }) {
    React.useEffect(() => {
      onManageComplete()
      setResult('✓ Disabled demo.')
      setViewState({ type: 'menu' })
    }, [onManageComplete, setResult, setViewState])
    return null
  },
}))

test('closing /plugin after a change applies it with /reload-plugins', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'plugin-apply-on-close-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  const { render } = await import('../../ink.js')
  const { KeybindingSetup } = await import('../../keybindings/KeybindingProviderSetup.js')
  const { AppStateProvider } = await import('../../state/AppState.js')
  const { PluginSettings } = await import('./PluginSettings.js')

  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  stdout.resume()
  const completions: unknown[][] = []
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <PluginSettings args="manage" onComplete={(...args) => completions.push(args)} />
      </KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await new Promise(resolve => setTimeout(resolve, 200))
    // 官方 2.1.329 tmux 实测：关闭菜单后自动出现 "Reloaded: …"，不需要手动 /reload-plugins。
    expect(completions).toEqual([
      ['✓ Disabled demo.', { nextInput: '/reload-plugins', submitNextInput: true }],
    ])
  } finally {
    instance.unmount()
    instance.cleanup()
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(configDir, { recursive: true, force: true })
  }
})
