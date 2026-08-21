#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import React from 'react'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import {
  AppStateProvider,
  getDefaultAppState,
} from '../../../state/AppState.js'

process.env.NODE_ENV = 'test'
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const { render } = await import('../../../ink.js')
const { AddWorkspaceDirectory } = await import('./AddWorkspaceDirectory.js')

class TestStdout extends Writable {
  columns = 100
  rows = 40
  isTTY = false
  output = ''

  _write(
    _chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.output += _chunk.toString()
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

const submitted: string[] = []
const stdin = new TestStdin()
const stdout = new TestStdout()
const instance = await render(
  <AppStateProvider initialState={getDefaultAppState()}>
    <AddWorkspaceDirectory
      onAddDirectory={path => submitted.push(path)}
      onCancel={() => {}}
      permissionContext={getEmptyToolPermissionContext()}
      validateLocally={false}
    />
  </AppStateProvider>,
  {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  },
)

try {
  await new Promise(resolve => setTimeout(resolve, 50))
  stdin.push('/remote-only/workspace\r')
  const deadline = Date.now() + 1000
  while (submitted.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(submitted, ['/remote-only/workspace'], stdout.output)
} finally {
  instance.unmount()
  instance.cleanup()
}

console.log('AddWorkspaceDirectory.test.tsx passed')
