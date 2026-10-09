import { describe, expect, test } from 'bun:test'
import { verifyNativeGeometryRequests } from './native-frame-journal-replay.mjs'

function fixture() {
  const clock = { nonce: 'a'.repeat(32), pid: 42, timebaseNumer: 1, timebaseDenom: 1 }
  const bracket = { method: 'native-mach-ioctl-resize-v1', result: 0, errno: 35,
    childPid: clock.pid, nonce: clock.nonce, timebaseNumer: 1, timebaseDenom: 1,
    entry: '100', return: '110' }
  const io = [
    { ioId: 1, kind: 'initial-geometry', childPid: 42, captureId: 'owned', geometryId: 0, columns: 110, rows: 34, rawOffset: 0 },
    { ioId: 2, kind: 'output', captureId: 'owned', geometryId: 0, rawOffset: 10 },
    { ioId: 3, kind: 'resize-ack', captureId: 'owned', geometryId: 1, columns: 109, rows: 34,
      rawOffset: 10, succeeded: true, nativeClockCorrelationCovered: true, nativeBracket: bracket },
    { ioId: 4, kind: 'output', captureId: 'owned', geometryId: 1, rawOffset: 20 },
  ]
  const send = { phase: 'resize-send', actionId: 1, target: 'owned:0.0', columns: 109, rows: 34,
    actualArgs: ['resize-window', '-t', 'owned:0.0', '-x', '109', '-y', '34'],
    lastObservedIoId: 2, lastObservedFrameId: 1, observedRawBytes: 10,
    nativeDriverClock: { method: 'driver-mach-absolute-time-v1', tick: '90', captureId: 'owned',
      nonce: clock.nonce, childPid: 42, callerPid: 900, callerThreadId: '901', timebaseNumer: 1, timebaseDenom: 1 } }
  // ACK can be published after the parent return. The send remains the lower bound.
  const geometry = [{ phase: 'launch', geometryId: 0, columns: 110, rows: 34, rawOffset: 0 }, send,
    { ...send, phase: 'resize-return', exitCode: 0, nativeDriverClock: { ...send.nativeDriverClock, tick: '95' } }]
  const events = [{ ioId: 3, geometryId: 1, beforeFrameId: 2, rawOffset: 10,
    columns: 109, rows: 34, nativeBracket: bracket }]
  const entries = [{ frameId: 1, rawStart: 0, rawEnd: 10 },
    { frameId: 2, rawStart: 10, rawEnd: 20, nativeSpan: { clock, observationKind: 'output-transaction',
      markers: [{ kind: 10, entry: '120', return: '121' }, { kind: 12, entry: '122', return: '123' },
        { kind: 13, entry: '139', return: '140' }, { kind: 11, entry: '141', return: '142' }] } }]
  const frames = [{ frameId: 1, columns: 110, rows: 34, outputBytes: 10, verdict: 'passed' },
    { frameId: 2, columns: 109, rows: 34, outputBytes: 10, verdict: 'passed' }]
  return { geometry, io, events, entries, frames, target: 'owned:0.0' }
}
const verify = f => verifyNativeGeometryRequests(f.geometry, f.io, f.events, f.entries, f.frames, f.target, 900)

describe('native original resize request and physical frame contracts', () => {
  test('uses the verified kernel write prefix when the broker read tail lags behind it', () => {
    const f = fixture()
    // The broker has consumed 10 bytes at ACK; five more old-size bytes were
    // already written before the non-overlapping kernel resize bracket.
    f.events[0].rawOffset = 15
    f.entries[0].rawEnd = 15
    f.entries[1].rawStart = 15
    f.frames[0].outputBytes = 15
    f.frames[1].outputBytes = 5
    expect(verify(f).verdict).toBe('passed')
    f.events[0].rawOffset = 9
    expect(() => verify(f)).toThrow()
    f.events[0].rawOffset = 21
    expect(() => verify(f)).toThrow()
  })
  test('pairs the original send/return, Mach ACK and actual painted frame without legacy aliases', () => {
    const result = verify(fixture())
    expect(result).toMatchObject({ method: 'native-driver-mach-frame-geometry-v2', verdict: 'passed',
      requested: 1, acknowledged: 1, actualInputOwnerCovered: false, productTimingEquivalent: false,
      sizes: [{ columns: 109, rows: 34, actionId: 1, ioId: 3, geometryId: 1, frameId: 2 }] })
    expect(result.geometryProof).toBeUndefined()
  })
  for (const [name, change] of [
    ['missing return', f => f.geometry.pop()],
    ['unsuccessful command', f => { f.geometry[2].exitCode = 1 }],
    ['wrong action', f => { f.geometry[2].actionId = 2 }],
    ['ACK before the request', f => { f.geometry[1].lastObservedIoId = 3; f.geometry[2].lastObservedIoId = 3 }],
    ['foreign target', f => { f.target = 'foreign:0.0' }],
    ['changed command arguments', f => { f.geometry[2].actualArgs = ['resize-window', '-t', 'foreign'] }],
    ['duplicate ACK', f => { f.io.push({ ...f.io[2] }) }],
    ['no subsequent frame', f => { f.events[0].beforeFrameId = 3 }],
    ['logical observation only', f => { f.entries[1].nativeSpan.observationKind = 'logical-observation' }],
    ['zero output', f => { f.entries[1].rawEnd = 10; f.frames[1].outputBytes = 0 }],
    ['wrong physical dimensions', f => { f.frames[1].columns = 110 }],
    ['failed physical comparison', f => { f.frames[1].verdict = 'failed' }],
    ['foreign clock', f => { f.entries[1].nativeSpan.clock.nonce = 'b'.repeat(32) }],
    ['frame before kernel return', f => { f.entries[1].nativeSpan.markers[0].entry = '109' }],
    ['numeric clock loses precision', f => { f.entries[1].nativeSpan.markers[0].entry = 120 }],
    ['boolean geometry', f => { f.geometry[1].columns = true }],
    ['changed raw boundary', f => { f.events[0].rawOffset = 11 }],
  ]) test(`rejects ${name}`, () => { const f = fixture(); change(f); expect(() => verify(f)).toThrow() })

  test('exact clocks remain usable above 2**53', () => {
    const f = fixture(), base = 2n ** 53n
    for (const row of f.geometry) if (row.nativeDriverClock) row.nativeDriverClock.tick = String(base + BigInt(row.nativeDriverClock.tick))
    for (const key of ['entry', 'return']) f.io[2].nativeBracket[key] = String(base + BigInt(f.io[2].nativeBracket[key]))
    for (const marker of f.entries[1].nativeSpan.markers)
      for (const key of ['entry', 'return']) marker[key] = String(base + BigInt(marker[key]))
    expect(verify(f).verdict).toBe('passed')
  })

  test('missing request ledger remains not covered', () => {
    const f = fixture(); f.geometry = null
    expect(verify(f).verdict).toBe('not covered')
  })

  test('a paint crossing the next kernel resize cannot acknowledge the earlier request', () => {
    const f = fixture(), bracket = { ...f.io[2].nativeBracket, entry: '200', return: '220' }
    f.io.push({ ...f.io[2], ioId: 5, geometryId: 2, columns: 110, rawOffset: 20, nativeBracket: bracket },
      { ioId: 6, kind: 'output', captureId: 'owned', geometryId: 2, rawOffset: 30 })
    const send = { ...f.geometry[1], actionId: 2, columns: 110,
      actualArgs: ['resize-window', '-t', 'owned:0.0', '-x', '110', '-y', '34'],
      lastObservedIoId: 4, lastObservedFrameId: 2, observedRawBytes: 20,
      nativeDriverClock: { ...f.geometry[1].nativeDriverClock, tick: '190' } }
    f.geometry.push(send, { ...send, phase: 'resize-return', exitCode: 0,
      nativeDriverClock: { ...send.nativeDriverClock, tick: '195' } })
    f.events.push({ ...f.events[0], ioId: 5, geometryId: 2, columns: 110,
      rawOffset: 20, beforeFrameId: 3, nativeBracket: bracket })
    f.entries.push({ ...f.entries[1], frameId: 3, rawStart: 20, rawEnd: 30,
      nativeSpan: { ...f.entries[1].nativeSpan, markers: [
        { kind: 10, entry: '230', return: '231' }, { kind: 12, entry: '232', return: '233' },
        { kind: 13, entry: '239', return: '240' }, { kind: 11, entry: '241', return: '242' }] } })
    f.frames.push({ frameId: 3, columns: 110, rows: 34, outputBytes: 10, verdict: 'passed' })
    expect(verify(f).requested).toBe(2)
    f.entries[1].nativeSpan.markers[2].return = '210'
    expect(() => verify(f)).toThrow('subsequent actual correctly sized physical frame')
  })
})
