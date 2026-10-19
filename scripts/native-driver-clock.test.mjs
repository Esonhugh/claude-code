import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { readNativeDriverClock } from './native-driver-clock.mjs'

const linux = process.platform === 'linux'
// Independent samples of the clock the platform observer stamps records with.
function independentClock() {
  if (!linux) {
    const system = dlopen('/usr/lib/libSystem.B.dylib', { mach_absolute_time: { args: [], returns: FFIType.u64 } })
    return { sample: () => BigInt(system.symbols.mach_absolute_time()), thread: undefined, close: () => system.close() }
  }
  const libc = dlopen('libc.so.6', { clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    gettid: { args: [], returns: FFIType.i32 } }), time = Buffer.alloc(16)
  return { sample: () => {
    expect(libc.symbols.clock_gettime(1, ptr(time))).toBe(0)
    return time.readBigInt64LE(0) * 1000000000n + time.readBigInt64LE(8)
  }, thread: String(libc.symbols.gettid()), close: () => libc.close() }
}

test(`actual Bun caller clock falls within independent ${linux ? 'CLOCK_MONOTONIC' : 'Mach'} samples`, () => {
  const run = mkdtempSync(join(tmpdir(), 'native-clock-bun-')),
    system = independentClock(),
    launch = { run, driverPid: process.pid, binarySha256: 'a'.repeat(64),
      capture: { nativeJournal: true, captureId: 'synthetic-enrollment-actual-caller-clock',
        ...(linux ? { observer: 'linux-seccomp-ptrace-v1' } : {}) } }
  try {
    writeFileSync(join(run, 'registration.json'), JSON.stringify({ nonce: 'b'.repeat(32) }), { mode: 0o600 })
    writeFileSync(join(run, 'start.json'), JSON.stringify({ childPid: process.pid + 1, binarySha256: launch.binarySha256 }), { mode: 0o600 })
    const before = system.sample(), clock = readNativeDriverClock(launch),
      after = system.sample(), next = readNativeDriverClock(launch)
    expect(before <= BigInt(clock.tick) && BigInt(clock.tick) <= after).toBe(true)
    expect(BigInt(next.tick) >= BigInt(clock.tick)).toBe(true)
    expect(clock).toMatchObject({ method: linux ? 'driver-linux-monotonic-v1' : 'driver-mach-absolute-time-v1',
      callerPid: process.pid, childPid: process.pid + 1, nonce: 'b'.repeat(32), captureId: launch.capture.captureId })
    expect(next.callerThreadId).toBe(clock.callerThreadId)
    expect(clock.timebaseNumer > 0 && clock.timebaseDenom > 0).toBe(true)
    if (linux) {
      expect(clock.callerThreadId).toBe(system.thread)
      expect([clock.timebaseNumer, clock.timebaseDenom]).toEqual([1, 1])
    }
    const evidence = process.env.BROKER_TEST_EVIDENCE_DIR
    if (evidence) {
      mkdirSync(evidence, { recursive: true })
      writeFileSync(join(evidence, 'actual-bun-driver-clock.json'), JSON.stringify({
        scope: 'actual caller clock; enrollment is synthetic, not CLI/UI proof',
        before: before.toString(), clock, after: after.toString(), next }) + '\n', { mode: 0o600, flag: 'wx' })
    }
    const caller = linux ? 'original Linux caller' : 'original Darwin caller'
    expect(() => readNativeDriverClock({ ...launch, driverPid: process.pid + 1 })).toThrow(caller)
    expect(() => readNativeDriverClock({ ...launch, capture: { ...launch.capture, nativeJournal: '1' } })).toThrow(caller)
    // A capture prepared for the other platform's observer never yields this host's clock.
    const { observer, ...unlabelled } = launch.capture
    expect(() => readNativeDriverClock({ ...launch, capture: linux ? unlabelled
      : { ...launch.capture, observer: 'linux-seccomp-ptrace-v1' } })).toThrow(caller)
    expect(() => readNativeDriverClock({ ...launch, capture: { ...launch.capture, observer: 'foreign-observer-v1' } })).toThrow(caller)
    writeFileSync(join(run, 'start.json'), JSON.stringify({ childPid: process.pid, binarySha256: launch.binarySha256 }))
    expect(() => readNativeDriverClock(launch)).toThrow('enrollment')
  } finally { rmSync(run, { recursive: true, force: true }); system.close() }
})

test('resize logging publishes original samples after the actual command call', async () => {
  const { createBuiltinCapture, recordedBuiltinTmux } = await import('./builtin-terminal-evidence.mjs')
  const { readFileSync } = await import('node:fs')
  const run = mkdtempSync(join(tmpdir(), 'native-clock-publication-')), binarySha256 = 'a'.repeat(64)
  try {
    const capture = createBuiltinCapture(run, ['/synthetic/native'], {}, { nativeJournal: true, binarySha256 }),
      launch = { run, capture, driverPid: process.pid, binarySha256,
        target: 'owned:0.0', tmux: '/synthetic/tmux', socket: join(run, 'socket') }
    writeFileSync(join(run, 'registration.json'), JSON.stringify({ nonce: 'b'.repeat(32) }), { mode: 0o600 })
    writeFileSync(join(run, 'start.json'), JSON.stringify({ childPid: process.pid + 1, binarySha256 }), { mode: 0o600 })
    const readGeometry = () => readFileSync(join(run, 'geometry.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    let observed
    recordedBuiltinTmux(launch, ['resize-window','-t',launch.target,'-x','109','-y','34'], () => {
      observed = readGeometry().length
      return ''
    })
    expect(observed).toBe(1)
    const rows = readGeometry()
    expect(rows.map(row => row.phase)).toEqual(['launch','resize-send','resize-return'])
    expect(BigInt(rows[1].nativeDriverClock.tick) <= BigInt(rows[2].nativeDriverClock.tick)).toBe(true)
  } finally { rmSync(run, { recursive: true, force: true }) }
})


test('command failure keeps its original identity when post-clock capture also fails', async () => {
  const { createBuiltinCapture, recordedBuiltinTmux } = await import('./builtin-terminal-evidence.mjs')
  const { readFileSync } = await import('node:fs')
  const run = mkdtempSync(join(tmpdir(), 'native-clock-command-error-')), binarySha256 = 'a'.repeat(64)
  try {
    const capture = createBuiltinCapture(run, ['/synthetic/native'], {}, { nativeJournal: true, binarySha256 }),
      launch = { run, capture, driverPid: process.pid, binarySha256,
        target: 'owned:0.0', tmux: '/synthetic/tmux', socket: join(run, 'socket') },
      original = Object.assign(Error('injected command failure'), { status: 7 })
    writeFileSync(join(run, 'registration.json'), JSON.stringify({ nonce: 'b'.repeat(32) }), { mode: 0o600 })
    writeFileSync(join(run, 'start.json'), JSON.stringify({ childPid: process.pid + 1, binarySha256 }), { mode: 0o600 })
    let caught
    try { recordedBuiltinTmux(launch, ['resize-window','-t',launch.target,'-x','109','-y','34'], () => {
      writeFileSync(join(run, 'start.json'), JSON.stringify({ childPid: process.pid, binarySha256 }))
      throw original
    }) } catch (error) { caught = error }
    expect(caught).toBe(original)
    const rows = readFileSync(join(run, 'geometry.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    expect(rows.at(-1).exitCode).toBe(7)
    expect(rows.at(-1).clockError).toContain('enrollment')
    expect(rows.at(-1).nativeDriverClock).toBeUndefined()
  } finally { rmSync(run, { recursive: true, force: true }) }
})

test('an actual evidence publication error cannot replace the original command error', async () => {
  const { createBuiltinCapture, recordedBuiltinTmux } = await import('./builtin-terminal-evidence.mjs')
  const { unlinkSync } = await import('node:fs')
  const run = mkdtempSync(join(tmpdir(), 'native-clock-publication-error-')), binarySha256 = 'a'.repeat(64)
  try {
    const capture = createBuiltinCapture(run, ['/synthetic/native'], {}, { nativeJournal: true, binarySha256 }),
      launch = { run, capture, driverPid: process.pid, binarySha256,
        target: 'owned:0.0', tmux: '/synthetic/tmux', socket: join(run, 'socket') },
      original = Object.assign(Error('injected original command error'), { status: 7 })
    writeFileSync(join(run, 'registration.json'), JSON.stringify({ nonce: 'b'.repeat(32) }), { mode: 0o600 })
    writeFileSync(join(run, 'start.json'), JSON.stringify({ childPid: process.pid + 1, binarySha256 }), { mode: 0o600 })
    let caught
    try { recordedBuiltinTmux(launch, ['resize-window','-t',launch.target,'-x','109','-y','34'], () => {
      unlinkSync(join(run, 'geometry.jsonl'));mkdirSync(join(run, 'geometry.jsonl'))
      throw original
    }) } catch (error) { caught = error }
    expect(caught).toBe(original)
  } finally { rmSync(run, { recursive: true, force: true }) }
})
