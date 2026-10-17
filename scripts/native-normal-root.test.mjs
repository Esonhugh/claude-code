import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import * as xterm from '@xterm/headless'
import { verifyNativeNormalOrigin, createNativeNormalRoots } from './native-normal-root.mjs'
const Terminal = xterm.Terminal ?? xterm.default?.Terminal ?? xterm['module.exports']?.Terminal
const roots = [], hash = bytes => createHash('sha256').update(bytes).digest('hex')
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const write = (terminal, bytes) => new Promise(resolve => terminal.write(bytes, resolve))
function fixture() {
  const run = mkdtempSync('/private/tmp/normal-origin-unit-'); roots.push(run)
  const expected = { captureId: 'owned', binarySha256: 'b'.repeat(64), columns: 20, rows: 10 }
  const origin = { method: 'builtin-fresh-tmux-normal-origin-v1', ...expected,
    driverPid: 1, serverPid: 2, panePid: 3, pane: '%1', target: 'mods:0.0',
    socket: join(run, 'tmux.sock'), rawOffset: 0, productTimingEquivalent: false, fullNativeGatePassed: false,
    measurements: { pane_id: '%1', pane_pid: '3', pid: '2', cursor_x: '0', cursor_y: '0',
      pane_width: '20', pane_height: '10', alternate_on: '0', pane_in_mode: '0', history_size: '0',
      origin_flag: '0', wrap_flag: '1', insert_flag: '0', cursor_flag: '1', scroll_region_upper: '0',
      scroll_region_lower: '9', version: '3.6b', pane_start_command: join(run, 'launch-captured.sh') },
    commands: [[], [], []], pendingEncoding: 'tmux-capture-p-P-C-v1', files: [] }
  for (const [name, text, mode] of [['native-origin-screen.txt', '\n'.repeat(10), 0o600],
      ['native-origin-pending.bin', '\n', 0o600], ['launch-captured.sh', '#!/bin/sh\n', 0o700]]) {
    const path = join(run, name); writeFileSync(path, text, { flag: 'wx', mode })
    origin.files.push({ path, sha256: hash(readFileSync(path)) })
  }
  const path = join(run, 'native-normal-origin.json')
  const save = () => { writeFileSync(path, JSON.stringify(origin) + '\n', { mode: 0o600 })
    expected.normalRootOrigin = { path, sha256: hash(readFileSync(path)) } }
  save()
  return { run, expected, origin, save }
}
test('held pre-Popen normal origin validates its original blank and parser files', () => {
  const f = fixture(); expect(verifyNativeNormalOrigin(f.run, f.expected).rawOffset).toBe(0)
  expect(verifyNativeNormalOrigin(f.run, { ...f.expected, normalRootOrigin: undefined })).toBeUndefined()
})
for (const [name, change] of [
  ['foreign capture', f => { f.origin.captureId = 'foreign' }],
  ['foreground origin mode', f => { f.origin.measurements.origin_flag = '1' }],
  ['changed scroll region', f => { f.origin.measurements.scroll_region_lower = '8' }],
  ['unknown tmux initialization', f => { f.origin.measurements.version = 'next' }],
  ['mid-row physical cursor', f => { f.origin.measurements.cursor_x = '1' }],
  ['a reused pane history', f => { f.origin.measurements.history_size = '1' }],
  ['preexisting raw output', f => { f.origin.rawOffset = 1 }],
]) test('rejects ' + name, () => {
  const f = fixture(); change(f); f.save()
  expect(() => verifyNativeNormalOrigin(f.run, f.expected)).toThrow()
})
test('encoded pending control bytes are rejected even with a fresh matching receipt', () => {
  const f = fixture(), file = f.origin.files[1]
  writeFileSync(file.path, '\\033[31\n'); file.sha256 = hash(readFileSync(file.path)); f.save()
  expect(() => verifyNativeNormalOrigin(f.run, f.expected)).toThrow('pending parser input')
})
test('post-enrollment descriptor and original file replacement cannot choose an anchor', () => {
  const f = fixture(); writeFileSync(f.expected.normalRootOrigin.path, '{}\n')
  expect(() => verifyNativeNormalOrigin(f.run, f.expected)).toThrow('changed after enrollment')
  f.save(); writeFileSync(f.origin.files[0].path, 'painted\n')
  expect(() => verifyNativeNormalOrigin(f.run, f.expected)).toThrow('file changed')
})
const entry = (rootEpoch = 1) => ({ native: { rendererId: 1, rootEpoch }, rootReset: true })
const frame = (cells, rows, cursor = { x: 0, y: 0 }) => ({ buffer: 'normal', columns: 20, rows,
  logicalViewport: { width: 20, height: 10 }, cursor, cells })
async function physical(body) {
  const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 10, logLevel: 'off' })
  const observer = createNativeNormalRoots(terminal, Terminal, { restrictedFresh: true })
  try { await body(terminal, observer) } finally { observer.dispose(); terminal.dispose() }
}
test('prefix is parsed before normal root and comparison is relative to the actual marker', async () => {
  await physical(async (terminal, observer) => {
    await write(terminal, 'prior\r\n')
    const wanted = frame([[0, 0, 'X', 1, '']], 1, { x: 1, y: 0 })
    observer.before(entry(), wanted)
    await write(terminal, 'X')
    expect(await observer.difference(wanted)).toBeUndefined()
    expect(await observer.difference({ ...wanted, cursor: { x: 1, y: 1 } })).toContain('cursor')
    expect(await observer.difference(frame([[0, 0, 'Y', 1, '']], 1, { x: 1, y: 0 }))).toContain('cell')
  })
})
test('missing origin and undeclared epoch remain rejected', async () => {
  await physical(async (terminal, observer) => {
    const wanted = frame([], 0)
    expect(() => observer.before({ ...entry(), rootReset: false }, wanted)).toThrow('epoch')
    const unknown = createNativeNormalRoots(terminal, Terminal)
    try { unknown.before(entry(), wanted); expect(await unknown.difference(wanted)).toContain('not covered') }
    finally { unknown.dispose() }
  })
})
test('a mid-row root can reacquire only after physical ED and HOME', async () => {
  await physical(async (terminal, observer) => {
    await write(terminal, 'prior')
    const wanted = frame([[0, 0, 'X', 1, '']], 1, { x: 1, y: 0 })
    observer.before(entry(), wanted)
    await write(terminal, 'X')
    expect(await observer.difference(wanted)).toContain('anchor was lost')
    await write(terminal, '\x1b[2J\x1b[HX')
    expect(await observer.difference(wanted)).toBeUndefined()
  })
})
test('shrinking a logical root still checks every previously painted tail row', async () => {
  await physical(async (terminal, observer) => {
    const first = frame([[0, 0, 'X', 1, ''], [0, 1, 'Y', 1, '']], 2, { x: 1, y: 1 })
    observer.before(entry(), first); await write(terminal, 'X\r\nY')
    expect(await observer.difference(first)).toBeUndefined()
    const shrunk = frame([[0, 0, 'X', 1, '']], 1, { x: 1, y: 0 })
    observer.before({ ...entry(), rootReset: false }, shrunk)
    await write(terminal, '\x1b[1A')
    expect(await observer.difference(shrunk)).toContain('cell 0,1')
  })
})
test('wide continuation style follows its lead and wrong visible style fails', async () => {
  await physical(async (terminal, observer) => {
    const wanted = frame([[0, 0, '中', 2, '\x1b[31m'], [1, 0, '', 0, '']], 1, { x: 2, y: 0 })
    observer.before(entry(), wanted); await write(terminal, '\x1b[31m中')
    expect(await observer.difference(wanted)).toBeUndefined()
    const altered = JSON.parse(JSON.stringify(wanted)); altered.cells[0][4] = '\x1b[32m'
    expect(await observer.difference(altered)).toContain('style differs')
  })
})
