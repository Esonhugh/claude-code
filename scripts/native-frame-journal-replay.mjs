import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { URL } from 'node:url'
import * as xterm from '@xterm/headless'
import { readOwnedNativeFile } from './native-evidence-files.mjs'
import { frameDifference } from './verify-terminal-frame-evidence.mjs'
import { semanticEvidence } from './terminal-frame-semantics.mjs'
import { verifyNativeNormalOrigin, createNativeNormalRoots } from './native-normal-root.mjs'
import { nativeEvidenceLocation, checkNativeEvidenceLocation } from './native-evidence-location.mjs'

const Terminal = xterm.Terminal ?? xterm.default?.Terminal ?? xterm['module.exports']?.Terminal
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const parserDigest = '17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed'

/** Requests, measured ioctl brackets and actual painted frames are distinct evidence. */
export function verifyNativeGeometryRequests(geometry, io, events, entries, frames, target, driverPid) {
  if (geometry === null) return { method: 'native-driver-mach-frame-geometry-v2', verdict: 'not covered' }
  const initial = io[0], launch = geometry[0]
  if (!launch || launch.phase !== 'launch' || launch.geometryId !== 0 || launch.rawOffset !== 0 ||
      initial?.kind !== 'initial-geometry' || launch.columns !== initial.columns || launch.rows !== initial.rows ||
      typeof target !== 'string' || !target)
    throw Error('Native request launch differs from measured capture geometry')
  const sends = geometry.filter(row => row.phase === 'resize-send'),
    returns = geometry.filter(row => row.phase === 'resize-return'),
    acks = io.filter(row => row.kind === 'resize-ack')
  if (geometry.length !== 1 + sends.length * 2 || sends.length !== returns.length ||
      sends.length !== acks.length || acks.length !== events.length)
    throw Error('Native geometry requests and measured ACKs are not a bijection')
  const tick = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) < 2n ** 64n
  const callerClock = (row, bracket) => {
    const clock = row?.nativeDriverClock
    return clock?.method === 'driver-mach-absolute-time-v1' && tick(clock.tick) &&
      clock.captureId === initial.captureId && clock.nonce === bracket.nonce &&
      clock.childPid === initial.childPid && clock.childPid === bracket.childPid &&
      Number.isSafeInteger(driverPid) && driverPid > 0 && clock.callerPid === driverPid &&
      driverPid !== clock.childPid && tick(clock.callerThreadId) &&
      clock.timebaseNumer === bracket.timebaseNumer && clock.timebaseDenom === bracket.timebaseDenom
  }
  const sizes = []
  for (const [index, send] of sends.entries()) {
    const returned = returns[index], ack = acks[index], event = events[index],
      next = sends[index + 1], nextAck = acks[index + 1], bracket = ack.nativeBracket
    const boundary = row => Number.isSafeInteger(row.lastObservedIoId) && row.lastObservedIoId > 0 &&
      row.lastObservedIoId <= io.length && Number.isSafeInteger(row.lastObservedFrameId) &&
      row.lastObservedFrameId >= 0 && row.lastObservedFrameId <= entries.length &&
      Number.isSafeInteger(row.observedRawBytes) && row.observedRawBytes >= 0 &&
      row.observedRawBytes <= io.at(-1).rawOffset
    if (!callerClock(send, bracket) || !callerClock(returned, bracket) ||
        send.nativeDriverClock.callerThreadId !== returned.nativeDriverClock.callerThreadId ||
        send.nativeDriverClock.callerThreadId !== sends[0].nativeDriverClock?.callerThreadId ||
        !tick(bracket.entry) || !tick(bracket.return) ||
        BigInt(bracket.return) < BigInt(bracket.entry) ||
        BigInt(send.nativeDriverClock.tick) > BigInt(returned.nativeDriverClock.tick) ||
        BigInt(bracket.entry) < BigInt(send.nativeDriverClock.tick) ||
        (next && (!callerClock(next, nextAck?.nativeBracket) ||
          BigInt(returned.nativeDriverClock.tick) > BigInt(next.nativeDriverClock.tick) ||
          BigInt(bracket.return) > BigInt(next.nativeDriverClock.tick))))
      throw Error('Native resize lacks an original caller Mach clock and unique request window')
    if (geometry[index * 2 + 1] !== send || geometry[index * 2 + 2] !== returned ||
        send.actionId !== index + 1 || returned.actionId !== send.actionId || returned.exitCode !== 0 ||
        !boundary(send) || !boundary(returned) ||
        ['lastObservedIoId', 'lastObservedFrameId', 'observedRawBytes'].some(key => returned[key] < send[key]) ||
        !Number.isSafeInteger(send.columns) || send.columns < 1 || send.columns > 1000 ||
        !Number.isSafeInteger(send.rows) || send.rows < 1 || send.rows > 1000 ||
        send.target !== target || returned.target !== target ||
        !isDeepStrictEqual(send.actualArgs, ['resize-window', '-t', target, '-x', String(send.columns), '-y', String(send.rows)]) ||
        !isDeepStrictEqual(returned.actualArgs, send.actualArgs) ||
        returned.columns !== send.columns || returned.rows !== send.rows ||
        ack.captureId !== initial.captureId || ack.succeeded !== true || ack.nativeClockCorrelationCovered !== true ||
        !Number.isSafeInteger(ack.ioId) || ack.geometryId !== index + 1 ||
        ack.ioId <= send.lastObservedIoId || ack.rawOffset < send.observedRawBytes ||
        ack.columns !== send.columns || ack.rows !== send.rows ||
        bracket?.method !== 'native-mach-ioctl-resize-v1' || bracket.result !== 0 ||
        bracket.childPid !== initial.childPid || event.ioId !== ack.ioId || event.geometryId !== ack.geometryId ||
        // The broker's consumed tail may lag the kernel write prefix verified
        // from the original non-overlapping Mach write/resize brackets.
        !Number.isSafeInteger(event.rawOffset) || event.rawOffset < ack.rawOffset ||
        event.rawOffset > io.at(-1).rawOffset ||
        !Number.isSafeInteger(event.beforeFrameId) || event.beforeFrameId < 1 || event.beforeFrameId > entries.length + 1 ||
        event.columns !== ack.columns || event.rows !== ack.rows || !isDeepStrictEqual(event.nativeBracket, bracket) ||
        (next && ['lastObservedIoId', 'lastObservedFrameId', 'observedRawBytes'].some(key => next[key] < returned[key])))
      throw Error('Native resize lacks a unique successful original send/return and ACK')
    const frame = entries.find(entry => {
      const span = entry.nativeSpan, painted = frames.find(row => row.frameId === entry.frameId)
      if (entry.frameId < event.beforeFrameId || entry.frameId <= send.lastObservedFrameId ||
          entry.rawStart < event.rawOffset || entry.rawEnd <= entry.rawStart ||
          span?.observationKind !== 'output-transaction' ||
          span.clock?.nonce !== bracket.nonce || span.clock?.pid !== bracket.childPid ||
          span.clock?.timebaseNumer !== bracket.timebaseNumer || span.clock?.timebaseDenom !== bracket.timebaseDenom ||
          !Array.isArray(span.markers) || span.markers[0]?.kind !== 10 || span.markers[2]?.kind !== 13 ||
          painted?.verdict !== 'passed' || painted.columns !== ack.columns || painted.rows !== ack.rows ||
          painted.outputBytes !== entry.rawEnd - entry.rawStart)
        return false
      const layout = span.markers[0].entry, end = span.markers[2].return
      if (![layout, end, bracket.entry, bracket.return, ...(nextAck ? [nextAck.nativeBracket?.entry] : [])].every(tick))
        return false
      return BigInt(layout) >= BigInt(bracket.return) && BigInt(end) >= BigInt(layout) &&
        (!nextAck || BigInt(end) <= BigInt(nextAck.nativeBracket.entry))
    })
    if (!frame) throw Error('Native resize has no subsequent actual correctly sized physical frame')
    sizes.push({ columns: ack.columns, rows: ack.rows, actionId: send.actionId,
      ioId: ack.ioId, geometryId: ack.geometryId, frameId: frame.frameId })
  }
  return { method: 'native-driver-mach-frame-geometry-v2', verdict: 'passed',
    requested: sends.length, acknowledged: acks.length, sizes,
    actualInputOwnerCovered: false, productTimingEquivalent: false }
}

/** Native write/resize brackets; unknown roots and input ownership remain uncovered. */
export async function replayNativeFrameJournal(run, expectedPath, path = join(run, 'frames.jsonl'), evidenceLocation) {
  const parserSHA256 = hash(readOwnedNativeFile(new URL(import.meta.resolve('@xterm/headless'))))
  if (parserSHA256 !== parserDigest) throw Error('Independent native parser does not match the pinned oracle')
  const location = evidenceLocation ? checkNativeEvidenceLocation(evidenceLocation, run) : nativeEvidenceLocation(run)
  if (location.receiptPath && !expectedPath.startsWith(run + '/'))
    throw Error('Archived native expectation must be inside its verified run')
  const expected = JSON.parse(location.receiptPath
    ? location.read(expectedPath.slice(run.length + 1)) : readOwnedNativeFile(expectedPath))
  const { columns, rows } = expected
  if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns <= 0 || rows <= 0)
    throw Error('Independent native geometry is required')
  const entries = readOwnedNativeFile(path).toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
  if (!entries.length) throw Error('No native Ink frames')
  const checked = spawnSync('python3', [join(import.meta.dir, 'verify-native-frame-journal.py'), run, expectedPath,
    ...(location.receiptPath ? [location.receiptPath] : [])],
                            { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 })
  if (checked.status !== 0 || checked.error)
    throw Error(`Original native evidence failed: ${checked.error?.message ?? checked.stdout.trim()}`)
  const native = JSON.parse(checked.stdout)
  if (!isDeepStrictEqual(entries, native.entries))
    throw Error('Derived frame/output does not match original native ledger')
  const terminal = new Terminal({ allowProposedApi: true, cols: columns, rows, logLevel: 'off' })
  const normalOrigin = verifyNativeNormalOrigin(run, expected, location)
  const normalRoots = createNativeNormalRoots(terminal, Terminal, normalOrigin)
  const frames = [], geometry = native.geometryEvents
  let geometryIndex = 0, rawOffset = 0
  const write = bytes => new Promise(resolve => terminal.write(bytes, resolve))
  async function writeThrough(bytes, frameId) {
    let consumed = 0
    while (geometryIndex < geometry.length && geometry[geometryIndex].beforeFrameId <= frameId) {
      const event = geometry[geometryIndex]
      if (event.rawOffset > rawOffset + bytes.length) break
      geometryIndex++
      const cut = event.rawOffset - rawOffset
      if (!Number.isSafeInteger(cut) || cut < consumed || cut > bytes.length)
        throw Error('Native resize has no ordered physical output prefix')
      await write(bytes.subarray(consumed, cut))
      terminal.resize(event.columns, event.rows)
      consumed = cut
    }
    await write(bytes.subarray(consumed))
    rawOffset += bytes.length
  }
  let closure
  try {
    for (const entry of entries) {
      const frame = JSON.parse(Buffer.from(entry.frameBase64, 'base64').toString('utf8'))
      const output = Buffer.from(entry.outputBase64, 'base64')
      if (!['native-frame-end-v1', 'native-pre-layout-observation-v1'].includes(entry.physicalBoundary) ||
          (entry.physicalBoundary === 'native-pre-layout-observation-v1' &&
           (entry.rawStart !== entry.rawEnd || entry.writeSequences.length !== 0 ||
            entry.nativeSpan.writes.length !== 0 || entry.nativeSpan.layoutRawStart !== entry.rawStart)))
        throw Error('Native frame has no proved physical comparison boundary')
      const prefixBytes = entry.rawStart - rawOffset
      if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 0 || prefixBytes > output.length)
        throw Error('Native frame start has no exact preceding raw prefix')
      await writeThrough(output.subarray(0, prefixBytes), entry.frameId)
      normalRoots.before(entry, frame)
      await writeThrough(output.subarray(prefixBytes), entry.frameId)
      let difference
      if (entry.native?.profile !== 'ink-post-write-v1') difference = 'Unsupported native frame profile'
      else if (frame.viewport?.width !== terminal.cols || frame.viewport?.height !== terminal.rows)
        difference = 'Logical viewport differs from independent native geometry'
      else if (typeof terminal._core?.coreService?.isCursorHidden !== 'boolean')
        difference = 'Independent cursor visibility API unavailable'
      else if (!terminal._core.coreService.isCursorHidden !== frame.cursor?.visible)
        difference = 'Native cursor visibility differs from immutable snapshot'
      else if (frame.buffer === 'normal') difference = await normalRoots.difference(frame)
      else difference = frameDifference(frame, terminal, Terminal)
      const text = Array.from({ length: terminal.rows }, (_, y) =>
        terminal.buffer.active.getLine(terminal.buffer.active.viewportY + y)?.translateToString(true) ?? '')
      frames.push({ frameId: entry.frameId, rawStart: entry.rawStart, rawEnd: entry.rawEnd,
                    columns: terminal.cols, rows: terminal.rows, text, semantic: semanticEvidence(text),
                    physicalBoundary: entry.physicalBoundary,
                    replayBytes: output.length, outputBytes: entry.rawEnd - entry.rawStart,
                    verdict: difference ? 'failed' : 'passed', difference })
    }
    const tail = Buffer.from(native.tailBase64, 'base64')
    await writeThrough(tail, entries.length + 1)
    if (geometryIndex !== geometry.length || rawOffset !== native.rawBytes)
      throw Error('Native geometry/output ledger is incomplete')
    closure = { outputBytes: tail.length, buffer: terminal.buffer.active.type,
                cursorX: terminal.buffer.active.cursorX, cursorY: terminal.buffer.active.cursorY,
                cursorVisible: !terminal._core.coreService.isCursorHidden,
                baseY: terminal.buffer.active.baseY, viewportY: terminal.buffer.active.viewportY }
    closure.verdict = closure.buffer === 'normal' && closure.cursorVisible === true ? 'passed' : 'failed'
  } finally {
    normalRoots.dispose()
    terminal.dispose()
  }
  let requestGeometry = null, target, driverPid
  try {
    const bytes = location.read('geometry.jsonl')
    if (!bytes.toString('utf8').endsWith('\n')) throw Error('Native request geometry is unsealed')
    requestGeometry = bytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
    const launch = JSON.parse(location.read('capture-launch.json'))
    if (launch.run !== location.originalRun || launch.binarySha256 !== expected.binarySha256 ||
        launch.capture?.captureId !== expected.captureId || launch.capture?.nativeJournal !== true)
      throw Error('Native resize request capture identity differs from original launch')
    target = launch.target
    driverPid = launch.driverPid
  } catch (error) {
    if (error.code !== 'ENOENT' || requestGeometry !== null) throw error
  }
  const nativeGeometryProof = verifyNativeGeometryRequests(requestGeometry, native.io, geometry, entries, frames, target, driverPid)
  return { method: 'native-journal-ioctl-geometry-replay-v1',
           framePhysicalBoundary: 'native-per-frame-boundary-v2',
           parserSHA256, semanticSource: 'independent-xterm-native-per-frame-v2',
           nativeGeometryProof,
           normalRootOrigin: normalOrigin ? { method: normalOrigin.method,
             verdict: 'passed', actualInputOwnerCovered: false, productTimingEquivalent: false } : { verdict: 'not covered' },
           sizeSequence: frames.filter((frame, index) => !index || frame.columns !== frames[index - 1].columns ||
             frame.rows !== frames[index - 1].rows).map(({ columns, rows, frameId }) => ({ columns, rows, frameId })),
           geometryEvents: geometry, nativeResizeBracketsCovered: geometry.length > 0,
           verdict: frames.every(frame => frame.verdict === 'passed') && closure.verdict === 'passed' ? 'passed' : 'failed',
           frameCount: frames.length, frames, closure, productTimingEquivalent: false,
           rawBytes: native.rawBytes, rawSha256: native.rawSha256,
           fullNativeGatePassed: false,
           remaining: ['termios lifetime', 'child-side unobserved geometry changes', 'actual input/owner',
                       'open-close-reopen matrix', 'default release matrix'] }
}

if (import.meta.main) {
  const [run, output, expected, frames] = process.argv.slice(2)
  let report
  try {
    if (!run || !output || !expected) throw Error('Usage: native-frame-journal-replay.mjs RUN REPORT EXPECTED.json [FRAMES.jsonl]')
    report = await replayNativeFrameJournal(run, expected, frames)
  } catch (error) {
    report = { verdict: 'failed', error: error.message, productTimingEquivalent: false, fullNativeGatePassed: false }
  }
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  if (report.verdict !== 'passed') process.exitCode = 1
}
