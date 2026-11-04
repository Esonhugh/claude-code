import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import React from 'react'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' } as MacroGlobals

class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  columns = 110
  rows = 20
  isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}

let config: string
let saved: string | undefined
beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), 'agent-view-'))
  saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
})
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = saved
  rmSync(config, { recursive: true, force: true })
})

test('the session list stays inside a short terminal and keeps the focused row in view', async () => {
  const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']
  names.forEach((name, i) => {
    const id = `job${i}`
    mkdirSync(join(config, 'jobs', id), { recursive: true })
    writeFileSync(join(config, 'jobs', id, 'state.json'), JSON.stringify({
      id, sessionId: `00000000-0000-0000-0000-00000000000${i}`, name, intent: name, cwd: config, args: [],
      state: i < 5 ? 'running' : 'stopped',
      createdAt: new Date(Date.now() - i * 1000).toISOString(), updatedAt: new Date().toISOString(),
    }))
  })
  const { render } = await import('../ink.js')
  const instances = (await import('../ink/instances.js')).default
  const { cellAt } = await import('../ink/screen.js')
  const { AgentView } = await import('./agentView.js')
  const stdin = new Input()
  const stdout = new Output()
  const instance = await render(
    <AgentView cwd={undefined} dispatch={{ flags: [] }} initialFocus={undefined} cameFrom={undefined} onAction={() => {}} />,
    { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false },
  )
  const ink = instances.get(stdout as never) as unknown as { frontFrame: { screen: Parameters<typeof cellAt>[0] } }
  const painted = () => {
    const screen = ink.frontFrame.screen
    return Array.from({ length: screen.height }, (_, y) =>
      Array.from({ length: screen.width }, (_, x) => cellAt(screen, x, y)?.char ?? ' ').join('').trimEnd())
  }
  const settle = async (check: () => boolean) => {
    const end = Date.now() + 3000
    while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20))
  }
  const shown = (name: string) => painted().filter(line => new RegExp(`[!✻∙] ${name} `).test(line)).length
  try {
    await settle(() => shown('alpha') === 1)
    const check = (focusName: string) => {
      const lines = painted()
      expect(lines.length).toBeLessThanOrEqual(20)
      for (const name of names) expect(shown(name)).toBeLessThanOrEqual(1)
      expect(shown(focusName)).toBe(1)
      expect(lines.some(line => line.includes('describe a task') || line.includes('reply'))).toBe(true)
    }
    check('alpha')
    stdin.push(' ')
    await settle(() => painted().some(line => line.includes('❯ reply')))
    check('alpha')
    stdin.push('\u001b')
    await settle(() => painted().some(line => line.includes('describe a task')))
    check('alpha')
    for (let i = 0; i < names.length; i++) {
      stdin.push('\u001b[B')
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    await settle(() => shown('hotel') === 1)
    check('hotel')
  } finally {
    instance.unmount()
  }
})
