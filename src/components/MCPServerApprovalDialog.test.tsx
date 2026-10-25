import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { render } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import { MCPServerApprovalDialog } from './MCPServerApprovalDialog.js'

async function renderDialog() {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <MCPServerApprovalDialog serverName="db" onDone={() => {}} />
      </KeybindingSetup>
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
    return stripAnsi(output)
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}

test('matches the official wording, option order and default focus', async () => {
  const output = await renderDialog()
  expect(output).toContain('New MCP server found in this project: db')
  const lines = output.split('\n')
  const at = (label: string) => lines.findIndex(line => line.includes(label))
  expect(at('Use this MCP server')).toBeLessThan(at('Use this and all future MCP servers'))
  expect(at('Use this and all future MCP servers')).toBeLessThan(at('Continue without using this MCP server'))
  expect(lines[at('Continue without using this MCP server')]).toMatch(/[❯>] Continue/)
  expect(output).not.toMatch(/1\. Use this/)
})
