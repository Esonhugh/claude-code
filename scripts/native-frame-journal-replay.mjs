import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import * as xterm from '@xterm/headless'
import { frameDifference } from './verify-terminal-frame-evidence.mjs'

const Terminal = xterm.Terminal ?? xterm.default?.Terminal ?? xterm['module.exports']?.Terminal

/** Native write/resize brackets; unknown roots and input ownership remain uncovered. */
export async function replayNativeFrameJournal(run, expectedPath, path = join(run, 'frames.jsonl')) {
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
  const { columns, rows } = expected
  if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns <= 0 || rows <= 0)
    throw Error('Independent native geometry is required')
  const entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  if (!entries.length) throw Error('No native Ink frames')
  const checked = spawnSync('python3', [join(import.meta.dir, 'verify-native-frame-journal.py'), run, expectedPath],
                            { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (checked.status !== 0 || checked.error)
    throw Error(`Original native evidence failed: ${checked.error?.message ?? checked.stdout.trim()}`)
  const native = JSON.parse(checked.stdout)
  if (!isDeepStrictEqual(entries, native.entries))
    throw Error('Derived frame/output does not match original native ledger')
  const terminal = new Terminal({ allowProposedApi: true, cols: columns, rows, logLevel: 'off' })
  const frames = [], geometry = native.geometryEvents
  let geometryIndex = 0, rawOffset = 0
  const write = bytes => new Promise(resolve => terminal.write(bytes, resolve))
  async function writeThrough(bytes, frameId) {
    let consumed = 0
    while (geometryIndex < geometry.length && geometry[geometryIndex].beforeFrameId <= frameId) {
      const event = geometry[geometryIndex++]
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
      await writeThrough(output, entry.frameId)
      let difference
      if (entry.native?.profile !== 'ink-post-write-v1') difference = 'Unsupported native frame profile'
      else if (frame.buffer !== 'alternate') difference = 'Normal root anchor is not covered by native geometry replay'
      else if (frame.viewport?.width !== terminal.cols || frame.viewport?.height !== terminal.rows)
        difference = 'Logical viewport differs from independent native geometry'
      else if (typeof terminal._core?.coreService?.isCursorHidden !== 'boolean')
        difference = 'Independent cursor visibility API unavailable'
      else if (!terminal._core.coreService.isCursorHidden !== frame.cursor?.visible)
        difference = 'Native cursor visibility differs from immutable snapshot'
      else difference = frameDifference(frame, terminal, Terminal)
      frames.push({ frameId: entry.frameId, rawStart: entry.rawStart, rawEnd: entry.rawEnd,
                    outputBytes: output.length, verdict: difference ? 'failed' : 'passed', difference })
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
    terminal.dispose()
  }
  return { method: 'native-journal-ioctl-geometry-replay-v1',
           framePhysicalBoundary: 'native-frame-end-v1',
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
