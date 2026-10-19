import { expect, test } from 'bun:test'
import React, { useContext } from 'react'
import { Readable, Writable } from 'node:stream'
import render from './root.js'
import instances from './instances.js'
import type { Frame } from './frame.js'
import { charInCellAt } from './screen.js'
import Text from './components/Text.js'
import { AlternateScreen } from './components/AlternateScreen.js'
import { TerminalSizeContext } from './components/TerminalSizeContext.js'
import { ENABLE_MOUSE_TRACKING } from './termio/dec.js'
import { ERASE_SCREEN } from './termio/csi.js'

// Mirrors Bun's tty.WriteStream: columns/rows are a cache refreshed only by
// _refreshSize (a TIOCGWINSZ that emits 'resize' when the size changed), which
// the runtime calls when it dispatches SIGWINCH from the event loop.
class TtyOutput extends Writable {
  isTTY = true
  columns = 200
  rows = 60
  kernel = { columns: 200, rows: 60 }
  written = ''
  _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.written += chunk.toString()
    done()
  }
  _refreshSize() {
    if (this.kernel.columns === this.columns && this.kernel.rows === this.rows) return
    this.columns = this.kernel.columns
    this.rows = this.kernel.rows
    this.emit('resize')
  }
}

function stdinStream() {
  return Object.assign(new Readable({ read() {} }), {
    isTTY: true, isRaw: false, setRawMode() { return this }, ref() { return this }, unref() { return this },
  }) as unknown as NodeJS.ReadStream
}

function Size() {
  const { columns, rows } = useContext(TerminalSizeContext)!
  return <Text>SIZE:{columns}x{rows}</Text>
}

function firstRow(frame: Frame) {
  return Array.from({ length: frame.screen.width }, (_, x) => charInCellAt(frame.screen, x, 0) ?? ' ').join('').trimEnd()
}

function count(text: string, needle: string) {
  return text.split(needle).length - 1
}

async function mount() {
  const stdout = new TtyOutput()
  const frames: Frame[] = []
  const app = await render(<AlternateScreen><Size /></AlternateScreen>, {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdinStream(), patchConsole: false, exitOnCtrlC: false,
    onFrame(event) { if (event.frame) frames.push(event.frame) },
  })
  const ink = instances.get(stdout as unknown as NodeJS.WriteStream)!
  ink.onRender()
  expect(firstRow(frames.at(-1)!)).toBe('SIZE:200x60')
  return { stdout, frames, app, ink }
}

test('a frame started after the kernel resize paints at the real size before the resize event is dispatched', async () => {
  const { stdout, frames, app, ink } = await mount()
  try {
    stdout.written = ''
    // The PTY was resized but the runtime has not dispatched SIGWINCH yet.
    stdout.kernel = { columns: 110, rows: 34 }
    ink.onRender()
    const frame = frames.at(-1)!
    expect([frame.screen.width, frame.screen.height]).toEqual([110, 34])
    expect(firstRow(frame)).toBe('SIZE:110x34')
    expect(count(stdout.written, ENABLE_MOUSE_TRACKING)).toBe(1)
    expect(count(stdout.written, ERASE_SCREEN)).toBe(1)

    // The late SIGWINCH dispatch for the same size must not reset again.
    stdout.written = ''
    stdout._refreshSize()
    stdout.emit('resize')
    ink.onRender()
    expect(firstRow(frames.at(-1)!)).toBe('SIZE:110x34')
    expect(count(stdout.written, ENABLE_MOUSE_TRACKING)).toBe(0)
    expect(count(stdout.written, ERASE_SCREEN)).toBe(0)
  } finally {
    app.unmount()
    app.cleanup()
  }
})

test('the resize event path still applies a new size once', async () => {
  const { stdout, frames, app, ink } = await mount()
  try {
    stdout.written = ''
    stdout.kernel = { columns: 90, rows: 20 }
    stdout._refreshSize()
    ink.onRender()
    const frame = frames.at(-1)!
    expect([frame.screen.width, frame.screen.height]).toEqual([90, 20])
    expect(firstRow(frame)).toBe('SIZE:90x20')
    expect(count(stdout.written, ENABLE_MOUSE_TRACKING)).toBe(1)
    expect(count(stdout.written, ERASE_SCREEN)).toBe(1)
  } finally {
    app.unmount()
    app.cleanup()
  }
})

test('a TTY without _refreshSize keeps using the cached size until its resize event', async () => {
  const stdout = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }),
    { columns: 80, rows: 24, isTTY: true }) as unknown as NodeJS.WriteStream
  const frames: Frame[] = []
  const app = await render(<AlternateScreen><Size /></AlternateScreen>, {
    stdout, stdin: stdinStream(), patchConsole: false, exitOnCtrlC: false,
    onFrame(event) { if (event.frame) frames.push(event.frame) },
  })
  try {
    const ink = instances.get(stdout)!
    Object.assign(stdout, { columns: 70, rows: 20 })
    ink.onRender()
    expect(firstRow(frames.at(-1)!)).toBe('SIZE:80x24')
    stdout.emit('resize')
    ink.onRender()
    expect(firstRow(frames.at(-1)!)).toBe('SIZE:70x20')
  } finally {
    app.unmount()
    app.cleanup()
  }
})
