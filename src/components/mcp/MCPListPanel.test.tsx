import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { render } from '../../ink.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { ServerInfo } from './types.js'
import { MCPListPanel } from './MCPListPanel.js'

process.env.NODE_ENV = 'test'
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: '0.0.0-test',
}

class TestStdout extends Writable {
  columns = 100
  rows = 40
  isTTY = false
  output = ''

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.output += chunk.toString()
    callback()
  }
}

class TestStdin extends Readable {
  isTTY = true
  isRaw = false
  _read() {}
  setRawMode(value: boolean) {
    this.isRaw = value
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

const config = {
  type: 'claudeai-proxy' as const,
  url: 'https://example.invalid/mcp',
  id: 'official-app-fixture',
  scope: 'claudeai' as const,
}
const client: MCPServerConnection = {
  name: 'claude.ai Claude Docs',
  type: 'pending',
  config,
}
const server: ServerInfo = {
  name: client.name,
  client,
  transport: 'claudeai-proxy',
  config,
  scope: 'claudeai',
}

const stdout = new TestStdout()
const stdin = new TestStdin()
const instance = await render(
  <MCPListPanel
    servers={[server]}
    onSelectServer={() => {}}
    onComplete={() => {}}
  />,
  {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
  },
)

const output = stripAnsi(stdout.output)
assert.match(output, /Claude AI \(Claude Official Apps\)/)
assert.match(output, /claude\.ai Claude Docs/)
assert.doesNotMatch(output, /\n\s*claude\.ai\s*\n/)
instance.unmount()
instance.cleanup()

console.log('MCPListPanel.test.tsx passed')
