import { afterAll, expect, mock, test } from 'bun:test'
import React from 'react'
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'agent-model-selector-test-'))
const originalHome = process.env.HOME
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = home
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(home, { recursive: true, force: true })
})

Object.defineProperty(globalThis, 'MACRO', { configurable: true, value: { VERSION: 'test' } })
let handlers: Record<string, () => void> = {}
mock.module('../../keybindings/useKeybinding.js', () => ({
  useKeybindings: (bindings: typeof handlers) => { handlers = bindings },
  useKeybinding: () => {},
}))
mock.module('../../utils/model/agent.js', () => ({
  AGENT_MODEL_OPTIONS: ['sonnet', 'opus', 'haiku', 'inherit'],
  getAgentModel: () => 'inherit',
  getDefaultSubagentModel: () => 'inherit',
  getAgentModelDisplay: (model: string) => model,
  getAgentModelOptions: () => ['sonnet', 'opus', 'haiku', 'inherit'].map(value => ({ value, label: value, description: value })),
}))
const { ModelSelector } = await import('./ModelSelector.js')
const { render } = await import('../../ink.js')

test('Enter on unset agents confirms inherit; custom and explicit choices round-trip', async () => {
  for (const initialModel of [undefined, 'Gateway/MixedCase', 'claude-opus-4-6', 'sonnet', 'inherit']) {
    let completed: string | undefined
    const stdout = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { columns: 100, rows: 30 })
    const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
    const instance = await render(<ModelSelector initialModel={initialModel} onComplete={model => { completed = model }} />, {
      stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      handlers['select:accept']!()
      expect(completed).toBe(initialModel ?? 'inherit')
      handlers['select:cancel']!()
      expect(completed).toBeUndefined()
    } finally { instance.unmount() }
  }
})
