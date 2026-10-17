import { expect, test } from 'bun:test'
import { verifyNativeGeometryRequests } from './native-frame-journal-replay.mjs'

// Synthetic causal contracts; these records do not claim actual native/UI proof.
function fixture(two = false) {
  const nativeClock = { nonce: 'a'.repeat(32), pid: 42, timebaseNumer: 125, timebaseDenom: 3 }
  const clock = tick => ({ method: 'driver-mach-absolute-time-v1', tick: String(tick),
    captureId: 'owned', nonce: nativeClock.nonce, childPid: 42,
    callerPid: 900, callerThreadId: '901', timebaseNumer: 125, timebaseDenom: 3 })
  const bracket = (entry, returned) => ({ method: 'native-mach-ioctl-resize-v1',
    result: 0, errno: 4, nonce: nativeClock.nonce, childPid: 42,
    timebaseNumer: 125, timebaseDenom: 3, entry: String(entry), return: String(returned) })
  const io = [{ ioId: 1, kind: 'initial-geometry', captureId: 'owned', childPid: 42,
    geometryId: 0, columns: 110, rows: 34, rawOffset: 0 },
    { ioId: 2, kind: 'output', captureId: 'owned', rawOffset: 10 }]
  const geometry = [{ phase: 'launch', geometryId: 0, columns: 110, rows: 34, rawOffset: 0 }]
  const entries = [{ frameId: 1, rawStart: 0, rawEnd: 10 }]
  const frames = [{ frameId: 1, columns: 110, rows: 34, outputBytes: 10, verdict: 'passed' }]
  const events = []
  for (let actionId = 1; actionId <= (two ? 2 : 1); actionId++) {
    const columns = actionId === 1 ? 109 : 110, base = actionId * 100,
      ack = { ioId: actionId * 2 + 1, kind: 'resize-ack', captureId: 'owned', geometryId: actionId,
        columns, rows: 34, rawOffset: actionId * 10, succeeded: true,
        nativeClockCorrelationCovered: true, nativeBracket: bracket(base, base + 10) }
    const send = { phase: 'resize-send', actionId, target: 'owned:0.0', columns, rows: 34,
      actualArgs: ['resize-window', '-t', 'owned:0.0', '-x', String(columns), '-y', '34'],
      lastObservedIoId: 2, lastObservedFrameId: 1, observedRawBytes: 10,
      nativeDriverClock: clock(base - 10) }
    geometry.push(send, { ...send, phase: 'resize-return', exitCode: 0, nativeDriverClock: clock(base - 5) })
    io.push(ack, { ioId: actionId * 2 + 2, kind: 'output', captureId: 'owned', rawOffset: (actionId + 1) * 10 })
    events.push({ ioId: ack.ioId, geometryId: actionId, rawOffset: ack.rawOffset,
      beforeFrameId: actionId + 1, columns, rows: 34, nativeBracket: ack.nativeBracket })
    entries.push({ frameId: actionId + 1, rawStart: actionId * 10, rawEnd: (actionId + 1) * 10,
      nativeSpan: { clock: nativeClock, observationKind: 'output-transaction', markers: [
        { kind: 10, entry: String(base + 20), return: String(base + 21) },
        { kind: 12, entry: String(base + 22), return: String(base + 23) },
        { kind: 13, entry: String(base + 39), return: String(base + 40) }] } })
    frames.push({ frameId: actionId + 1, columns, rows: 34, outputBytes: 10, verdict: 'passed' })
  }
  return { geometry, io, events, entries, frames }
}
const verify = f => verifyNativeGeometryRequests(f.geometry, f.io, f.events, f.entries, f.frames, 'owned:0.0', 900)

test('real Mach order tolerates an asynchronously published stale next-send tail', () => {
  expect(verify(fixture(true)).verdict).toBe('passed')
})
for (const [name, change] of [
  ['missing actual driver clock', f => { delete f.geometry[1].nativeDriverClock }],
  ['ACK before actual send', f => { f.geometry[1].nativeDriverClock.tick = '111'; f.geometry[2].nativeDriverClock.tick = '112' }],
  ['caller impersonating child', f => { f.geometry[1].nativeDriverClock.callerPid = 42 }],
  ['caller differs from original launch', f => { f.geometry[1].nativeDriverClock.callerPid = 901 }],
  ['foreign native enrollment', f => { f.geometry[1].nativeDriverClock.nonce = 'b'.repeat(32) }],
  ['foreign capture', f => { f.geometry[1].nativeDriverClock.captureId = 'foreign' }],
  ['different timebase', f => { f.geometry[1].nativeDriverClock.timebaseDenom = 1 }],
  ['numeric clock', f => { f.geometry[1].nativeDriverClock.tick = 90 }],
  ['uint64 overflow', f => { f.geometry[1].nativeDriverClock.tick = String(2n ** 64n) }],
  ['noncanonical clock', f => { f.geometry[1].nativeDriverClock.tick = '090' }],
  ['return before command entry', f => { f.geometry[2].nativeDriverClock.tick = '89' }],
  ['thread differs on command return', f => { f.geometry[2].nativeDriverClock.callerThreadId = '902' }],
]) test(`rejects ${name}`, () => { const f = fixture(); change(f); expect(() => verify(f)).toThrow() })

test('an ACK outside the actual next command window remains unassociated', () => {
  const f = fixture(true)
  f.geometry[3].nativeDriverClock.tick = '109'
  expect(() => verify(f)).toThrow()
})

test('driver clocks preserve uint64 precision above 2**53', () => {
  const f = fixture(true), offset = 2n ** 53n
  for (const row of f.geometry) if (row.nativeDriverClock) row.nativeDriverClock.tick = String(offset + BigInt(row.nativeDriverClock.tick))
  for (const ack of f.io.filter(row => row.kind === 'resize-ack'))
    for (const key of ['entry','return']) ack.nativeBracket[key] = String(offset + BigInt(ack.nativeBracket[key]))
  for (const entry of f.entries) if (entry.nativeSpan)
    for (const marker of entry.nativeSpan.markers)
      for (const key of ['entry','return']) marker[key] = String(offset + BigInt(marker[key]))
  expect(verify(f).requested).toBe(2)
})


test('an earlier paint may finish after the next command starts but before its actual ACK', () => {
  const f = fixture(true)
  f.geometry[3].nativeDriverClock.tick = '130'
  f.geometry[4].nativeDriverClock.tick = '135'
  expect(verify(f).requested).toBe(2)
})
