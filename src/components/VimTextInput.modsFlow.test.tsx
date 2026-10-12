import { expect, test } from 'bun:test'
import React, { useLayoutEffect, useState } from 'react'
import { Readable, Writable } from 'node:stream'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThemeProvider, render } from '../ink.js'
import { createModsRuntime } from '../services/mods/runtime.js'
import { createModPromptEditQueue, runModPromptEdit } from '../services/mods/promptEdit.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import type { TextInputEdit, VimMode } from '../types/textInputTypes.js'
import VimTextInput from './VimTextInput.js'

class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  columns = 80
  rows = 24
  isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}

async function mount(value = '', offset = value.length, mode: VimMode = 'INSERT', relay?: (edit: TextInputEdit) => void) {
  const stdin = new Input(), stdout = new Output(), edits: TextInputEdit[] = []
  let box = { value, offset, mode }
  let committed = { value, offset, mode }
  const commitListeners = new Set<() => void>()
  let replace: (value: string, offset: number) => void
  function Probe() {
    const [text, setText] = useState(value)
    const [cursor, setCursor] = useState(offset)
    const [vimMode, setVimMode] = useState(mode)
    useLayoutEffect(() => {
      committed = { value: text, offset: cursor, mode: vimMode }
      for (const listener of commitListeners) listener()
    }, [text, cursor, vimMode])
    replace = (next, caret) => { box = { ...box, value: next, offset: caret }; setText(next); setCursor(caret) }
    return <VimTextInput value={text} cursorOffset={cursor} initialMode={vimMode}
      onChange={next => { box = { ...box, value: next }; setText(next) }}
      onChangeCursorOffset={next => { box = { ...box, offset: next }; setCursor(next) }}
      onModeChange={next => { box = { ...box, mode: next }; setVimMode(next) }}
      onEdit={edit => { edits.push(structuredClone(edit)); relay?.(edit) }}
      onSubmit={() => { throw Error('This fixture does not submit') }}
      onExit={() => { throw Error('This fixture does not exit') }}
      focus showCursor multiline columns={80} disableEscapeDoublePress />
  }
  const instance = await render(<AppStoreContext value={createStore(getDefaultAppState())}>
    <ThemeProvider initialState="dark"><Probe /></ThemeProvider>
  </AppStoreContext>, { stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false })
  async function settle() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
  await settle()
  return {
    edits, get box() { return box },
    get committed() { return committed },
    waitForCommit() {
      const matches = () => committed.value === box.value && committed.offset === box.offset && committed.mode === box.mode
      if (matches()) return Promise.resolve()
      return new Promise<void>(resolve => {
        const listener = () => { if (matches()) { commitListeners.delete(listener); resolve() } }
        commitListeners.add(listener)
      })
    },
    adopt(value: string, offset: number) { replace(value, offset) },
    async send(data: string) { stdin.push(data); await settle() },
    async replace(value: string, offset: number) { replace(value, offset); await settle() },
    close() { instance.unmount(); instance.cleanup() },
  }
}

// Fixed 2.1.289 er/Fe: a Normal multi-code-point event executes successive
// commands against the live text/caret; no part of that event raises editRelay.
test.each([
  ['', 0, 'iabc', { value: 'abc', offset: 3, mode: 'INSERT' }],
  ['ab', 0, 'a中😀', { value: 'a中😀b', offset: 4, mode: 'INSERT' }],
  ['abcd', 0, '2x', { value: 'cd', offset: 0, mode: 'NORMAL' }],
  ['one two', 1, 'diw', { value: ' two', offset: 0, mode: 'NORMAL' }],
] as const)('mounted Vim handles Normal single text event %s %i %s without a relay', async (value, offset, input, expected) => {
  const h = await mount(value, offset, 'NORMAL')
  try { await h.send(input); expect(h.box).toEqual(expected); expect(h.edits).toEqual([]) }
  finally { h.close() }
})

test.each(['a😀', 'a👍🏽', 'a👩‍💻'])('mounted Vim Esc retreats one whole grapheme in %s without edit relay', async value => {
  const h = await mount(value)
  try { await h.send('\x1b[27u'); expect(h.box).toEqual({ value, offset: 1, mode: 'NORMAL' }); expect(h.edits).toEqual([]) }
  finally { h.close() }
})

test.each(['', 'a\n'])('mounted Vim Esc preserves its existing zero and beginning-of-line guard in %s', async value => {
  const h = await mount(value)
  try { await h.send('\x1b[27u'); expect(h.box).toEqual({ value, offset: value.length, mode: 'NORMAL' }); expect(h.edits).toEqual([]) }
  finally { h.close() }
})

test('mounted Vim Esc preserves the official one-unit fallback for a caret beyond the text', async () => {
  const h = await mount('ab', 7)
  try { await h.send('\x1b[27u'); expect(h.box).toEqual({ value: 'ab', offset: 6, mode: 'NORMAL' }); expect(h.edits).toEqual([]) }
  finally { h.close() }
})

test('mounted Vim Insert typing, Esc and x in one stdin read use the accepted live draft', async () => {
  const h = await mount('a')
  try {
    await h.send('😀\x1b[27ux')
    expect(h.box).toEqual({ value: 'a', offset: 0, mode: 'NORMAL' })
    expect(h.edits).toEqual([{ before: { text: 'a', cursor: 1 }, after: { text: 'a😀', cursor: 3 }, key: { key: '😀' } }])
  } finally { h.close() }
})

test('mounted Vim Normal insertion remainder, Esc and x in one stdin read keep Normal mutations out of relay', async () => {
  const h = await mount('', 0, 'NORMAL')
  try { await h.send('iabc\x1b[27ux'); expect(h.box).toEqual({ value: 'ab', offset: 1, mode: 'NORMAL' }); expect(h.edits).toEqual([]) }
  finally { h.close() }
})

test('mounted Vim re-reads application replacement before Esc and Normal operators', async () => {
  const h = await mount('', 0, 'NORMAL')
  try {
    await h.send('iabc'); await h.replace('HELLO😀', 7); await h.send('\x1b[27ux')
    expect(h.box).toEqual({ value: 'HELLO', offset: 4, mode: 'NORMAL' }); expect(h.edits).toEqual([])
  } finally { h.close() }
})

test('mounted Vim Normal remainder then Insert base key in one stdin read preserves text and reports the live before box', async () => {
  const h = await mount('', 0, 'NORMAL')
  try {
    await h.send('iabc\x1b[27ua\x1b[120u')
    expect(h.box).toEqual({ value: 'abcx', offset: 4, mode: 'INSERT' })
    expect(h.edits).toEqual([{ before: { text: 'abc', cursor: 3 }, after: { text: 'abcx', cursor: 4 }, key: { key: 'x' } }])
  } finally { h.close() }
})

test('mounted Vim Normal remainder then left in one stdin read uses nonempty draft qualification', async () => {
  const h = await mount('', 0, 'NORMAL')
  try {
    await h.send('iabc\x1b[27u\x1b[D')
    expect(h.box).toEqual({ value: 'abc', offset: 1, mode: 'NORMAL' })
    expect(h.edits).toEqual([])
  } finally { h.close() }
})

test('mounted Vim ordinary Insert keys in one stdin read still record every live base edit', async () => {
  const h = await mount()
  try {
    await h.send('abc\x1b[D\x7f')
    expect(h.box).toEqual({ value: 'ac', offset: 1, mode: 'INSERT' })
    expect(h.edits).toEqual([
      { before: { text: '', cursor: 0 }, after: { text: 'abc', cursor: 3 } },
      { before: { text: 'abc', cursor: 3 }, after: { text: 'abc', cursor: 2 }, key: { key: 'left' } },
      { before: { text: 'abc', cursor: 2 }, after: { text: 'ac', cursor: 1 }, key: { key: 'backspace' } },
    ])
  } finally { h.close() }
})

test('mounted Vim mode roundtrip sends only its later live Insert edit through a real author Worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-vim-live-edit-'))
  const folder = join(root, 'plugin'), entry = join(folder, 'register.ts')
  await mkdir(folder)
  await writeFile(entry, `export function register(on) {on('prompt.edit',async ($,e,next)=>{const r=await next(e);return {...r,text:r.text.toUpperCase()}})}`)
  const diagnostics: unknown[] = []
  const settled = Promise.withResolvers<void>()
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  let queue: ReturnType<typeof createModPromptEditQueue> | undefined
  let h: Awaited<ReturnType<typeof mount>> | undefined
  try {
    await runtime.reconcile([{ name: 'vim-edit-probe', storageId: 'vim-edit-probe@test', pluginRoot: folder, entrypoints: [entry] }])
    h = await mount('', 0, 'NORMAL', edit => queue!.record(edit))
    queue = createModPromptEditQueue({
      read: () => ({ text: h!.box.value, cursor: h!.box.offset }),
      commit: next => h!.adopt(next.text, next.cursor),
      paint: () => settled.resolve(),
      raise: async (edit, signal) => {
        const snapshot = runtime.capture()
        try { return await runModPromptEdit(snapshot, edit, signal) }
        finally { snapshot.release() }
      },
      report: reason => { diagnostics.push(reason); settled.resolve() },
    })
    await h.send('iabc\x1b[27ua\x1b[120u')
    // Await the real queue settlement and React commit without spinning the
    // host event loop while the author's 50ms hook budget is running.
    const deadline = Promise.withResolvers<never>()
    const timer = setTimeout(() => deadline.reject(new Error('Vim edit did not settle within 1000ms')), 1000)
    try {
      await Promise.race([(async () => { await settled.promise; await h!.waitForCommit() })(), deadline.promise])
    } finally { clearTimeout(timer) }
    expect(h.box).toEqual({ value: 'ABCX', offset: 4, mode: 'INSERT' })
    expect(h.edits).toEqual([{ before: { text: 'abc', cursor: 3 }, after: { text: 'abcx', cursor: 4 }, key: { key: 'x' } }])
    expect(diagnostics).toEqual([])
    expect(h.committed).toEqual({ value: 'ABCX', offset: 4, mode: 'INSERT' })
    await h.send('\x1b[27ux')
    expect(h.box).toEqual({ value: 'ABC', offset: 2, mode: 'NORMAL' })
    expect(h.edits).toHaveLength(1)
  } finally {
    queue?.dispose(); h?.close()
    await runtime.dispose(); await rm(root, { recursive: true, force: true })
  }
})
