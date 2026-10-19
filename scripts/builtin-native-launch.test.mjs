import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createBuiltinNativeLauncher, createBuiltinCapture, installBuiltinCapture } from './builtin-terminal-evidence.mjs'
const roots = []
const run = () => { const root = mkdtempSync(join(tmpdir(), 'builtin-launch-unit-')); roots.push(root); return root }
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
afterAll(() => { for (const path of roots) rmSync(path, { recursive: true, force: true }) })

test('native sandbox launcher holds exact original helpers and forwards the full native argv', () => {
  const root = run(), launcher = createBuiltinNativeLauncher(root)
  const manifest = JSON.parse(readFileSync(join(root, 'native-broker/helpers.json')))
  expect(manifest.files).toHaveLength(5)
  for (const row of manifest.files) {
    expect(hash(join(root, 'native-broker', row.name))).toBe(row.sha256)
    expect(hash(join(dirname(import.meta.path), row.name))).toBe(row.sha256)
  }
  expect(launcher.pinnedFiles).toHaveLength(7)
  const shell = readFileSync(launcher.path, 'utf8')
  expect(shell).toContain('exec /usr/bin/python3')
  expect(shell).toContain(' -- "$@"')
  expect(shell).toContain(launcher.broker)
  expect(shell).not.toContain('DYLD_INSERT_LIBRARIES')
})

test('changed native helper is rejected before capture-ready releases the producer', () => {
  const root = run(), nativeLauncher = createBuiltinNativeLauncher(root), env = {}
  const sandbox = process.platform === 'linux'
    ? ['/usr/bin/python3', join(root, 'linux-sandbox-exec.py'), '--policy', '{}', '--']
    : ['/usr/bin/sandbox-exec', '-f', join(root, 'sandbox.sb')]
  const capture = createBuiltinCapture(root, [...sandbox, nativeLauncher.path, '/fixture/native'], env,
    { nativeJournal: true, brokerPlacement: 'launcher-final-native-exec', nativeLauncher, binarySha256: 'b'.repeat(64) })
  expect(capture.observer).toBe(process.platform === 'linux' ? 'linux-seccomp-ptrace-v1' : undefined)
  writeFileSync(nativeLauncher.broker, 'changed helper')
  const calls = []
  expect(() => installBuiltinCapture({ run: root, socket: join(root, 'tmux.sock'), target: 'mods:0.0', tmux: '/fixture/tmux', env }, capture,
    (_file, args) => { calls.push(args); return args.includes('display-message') ? '1\n' : '' })).toThrow('Prepared native launcher changed')
  expect(existsSync(capture.ready)).toBe(false)
  expect(calls.at(-1)).toContain('kill-server')
})

test('the normal origin records the tmux version the platform reports', () => {
  const root = run(), nativeLauncher = createBuiltinNativeLauncher(root), env = {}
  const sandbox = process.platform === 'linux'
    ? ['/usr/bin/python3', join(root, 'linux-sandbox-exec.py'), '--policy', '{}', '--']
    : ['/usr/bin/sandbox-exec', '-f', join(root, 'sandbox.sb')]
  const capture = createBuiltinCapture(root, [...sandbox, nativeLauncher.path, '/fixture/native'], env,
    { nativeJournal: true, brokerPlacement: 'launcher-final-native-exec', nativeLauncher, binarySha256: 'b'.repeat(64) })
  const { columns, rows } = capture.initialSize, reported = process.platform === 'linux' ? '3.4' : '3.6b'
  installBuiltinCapture({ run: root, socket: join(root, 'tmux.sock'), target: 'mods:0.0', tmux: '/fixture/tmux', env,
    freshPane: true, pane: '%1', serverPid: 2 }, capture, (_file, args) => {
    if (args.at(-1) === '#{pane_pipe}') return '1\n'
    if (args.includes('display-message')) return ['%1', '3', '2', '0', '0', String(columns), String(rows),
      '0', '0', '0', '0', '1', '0', '1', '0', String(rows - 1), reported, capture.wrapper].join('\t') + '\n'
    if (args.includes('capture-pane')) return args.includes('-P') ? '\n' : '\n'.repeat(rows)
    return ''
  })
  const origin = JSON.parse(readFileSync(join(root, 'native-normal-origin.json'), 'utf8'))
  expect(origin.measurements.version).toBe(reported)
  expect(origin.initialStateBasis).toContain(`tmux ${reported} `)
  if (process.platform === 'linux') expect([origin.platform, origin.tmuxVersion]).toEqual(['linux', '3.4'])
  else expect('platform' in origin || 'tmuxVersion' in origin).toBe(false)
})

test('native helper preparation preserves a preexisting directory and its contents', () => {
  const root = run(), folder = join(root, 'native-broker'), sentinel = join(folder, 'sentinel')
  mkdirSync(folder)
  writeFileSync(sentinel, 'older owner')
  expect(() => createBuiltinNativeLauncher(root)).toThrow()
  expect(readFileSync(sentinel, 'utf8')).toBe('older owner')
  expect(existsSync(join(folder, 'helpers.json'))).toBe(false)
})
