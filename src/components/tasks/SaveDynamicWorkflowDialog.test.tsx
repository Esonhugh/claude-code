import { expect, test } from 'bun:test'
import { Readable, Writable } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { render } from '../../ink.js'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import { SaveDynamicWorkflowDialog } from './SaveDynamicWorkflowDialog.js'

class Output extends Writable {
  rows = 40
  columns = 120
  isTTY = false
  output = ''
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.output += chunk.toString()
    callback()
  }
}

class Input extends Readable {
  isTTY = true
  isRaw = false
  _read() {}
  setRawMode(value: boolean) {
    this.isRaw = value
    return this
  }
  ref() { return this }
  unref() { return this }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 60))
const lines = (stdout: Output) => stripAnsi(stdout.output).split('\n').filter(line => line.trim())
const lastFrame = (stdout: Output) => {
  const text = lines(stdout).join('\n')
  const start = text.lastIndexOf('Save dynamic workflow')
  return text.slice(start)
}

test('the save dialog previews the path, toggles scope with Tab and tracks the typed name', async () => {
  const stdout = new Output()
  const stdin = new Input()
  const done: Array<string | undefined> = []
  const instance = await render(
    <AppStoreContext.Provider value={createStore(getDefaultAppState())}>
      <SaveDynamicWorkflowDialog script="return 1" defaultName="Probe Flow" onDone={message => done.push(message)} />
    </AppStoreContext.Provider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await settle()
    let frame = lastFrame(stdout)
    expect(frame).toContain('Save dynamic workflow')
    expect(frame).toContain('Project scope · .claude/workflows/probe-flow.js')
    expect(frame).toContain('Save as:')
    expect(frame).toContain('> Probe Flow')
    expect(frame).toMatch(/enter.*save/)
    expect(frame).toMatch(/tab.*toggle scope/)
    expect(frame).toMatch(/escape.*cancel/)

    stdin.push('\t')
    await settle()
    frame = lastFrame(stdout)
    expect(frame).toContain('User scope · ~/.claude/workflows/probe-flow.js')

    stdin.push(' v2')
    await settle()
    frame = lastFrame(stdout)
    expect(frame).toContain('> Probe Flow v2')
    expect(frame).toContain('User scope · ~/.claude/workflows/probe-flow-v2.js')
    expect(done).toEqual([])
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
