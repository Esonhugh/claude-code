import { test, expect, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { URL } from 'node:url'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  cpSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyGeometryLedger, verifyPtyTerminalEvidence } from './verify-pty-terminal-evidence.mjs'
import {
  sealBuiltinCapture,
  validateBuiltinTerminalEvidence,
} from './builtin-terminal-evidence.mjs'
import { recheckBuiltinSide } from './recheck-builtin-terminal-evidence.mjs'
const roots = []

// A no-write logical observation straddles a real resize; the following
// observation must independently establish the new measured viewport.
function zeroWriteResizeFixture(middleViewport = { width: 10, height: 8 }) {
  const before = { ...frame('AB', { x: 2, y: 0, visible: true }), buffer: 'alternate',
    logicalViewport: { width: 10, height: 9 } }
  const after = { ...before, viewport: { width: 10, height: 6 }, logicalViewport: { width: 10, height: 7 } }
  const middle = { ...before, viewport: middleViewport,
    logicalViewport: { width: middleViewport.width, height: middleViewport.height + 1 } }
  const { run, frames, io } = fixture([
    { output: '\x1b[?1049h\x1b[HAB', frame: before },
    { output: '', frame: middle },
    { output: '', frame: after },
  ])
  const start = frames[1].broker.start
  const end = frames[1].broker.end
  const ack = { kind: 'resize-ack', rawOffset: start.rawOffset, columns: 10, rows: 6,
    captureId: frames[1].captureId, ioctl: 'TIOCSWINSZ', succeeded: true }
  io.splice(io.indexOf(end), 0, ack)
  let geometryId = 0
  io.forEach((event, index) => {
    event.ioId = index + 1
    if (event.kind === 'resize-ack') geometryId++
    event.geometryId = geometryId
  })
  writeFileSync(join(run, 'pty-io.jsonl'), io.map(JSON.stringify).join('\n') + '\n')
  writeFileSync(join(run, 'frames.jsonl'), frames.map(JSON.stringify).join('\n') + '\n')
  writeFileSync(join(run, 'geometry.jsonl'), [
    { phase: 'launch', columns: 10, rows: 8 },
    { phase: 'resize-send', actionId: 1, columns: 10, rows: 6, lastObservedIoId: start.ioId },
    { phase: 'resize-return', actionId: 1, columns: 10, rows: 6, exitCode: 0 },
  ].map(JSON.stringify).join('\n') + '\n')
  return { run, frames, io, start, end, ack }
}
const frame = (text, cursor = { x: 0, y: 1, visible: true }) => ({
  columns: 10,
  rows: 1,
  viewport: { width: 10, height: 8 },
  cursor,
  buffer: 'normal',
  cells: [...text].flatMap((char, x) => [[x, 0, char, 1, '']]),
})
function fixture(groups, prefixText = 'prefix\r\n') {
  const run = mkdtempSync(join(tmpdir(), 'pty-oracle-'))
  roots.push(run)
  const prefix = Buffer.from(prefixText),
    chunks = [prefix],
    io = [
      {
        ioId: 1,
        kind: 'initial-geometry',
        rawOffset: 0,
        geometryId: 0,
        columns: 10,
        rows: 8,
        childPid: 123,
      },
    ],
    frames = []
  let offset = prefix.length,
    id = 1,
    request = 0
  io.push({
    ioId: ++id,
    kind: 'output',
    rawOffset: offset,
    geometryId: 0,
    start: 0,
    end: offset,
  })
  for (const [index, group] of groups.entries()) {
    const start = {
      ioId: ++id,
      kind: 'frame-start',
      requestId: ++request,
      rendererId: 1,
      rootEpoch: 1,
      rawOffset: offset,
      geometryId: 0,
    }
    io.push(start)
    const bytes = Buffer.from(group.output),
      before = offset
    chunks.push(bytes)
    offset += bytes.length
    if (bytes.length)
      io.push({
        ioId: ++id,
        kind: 'output',
        rawOffset: offset,
        geometryId: 0,
        start: before,
        end: offset,
      })
    const end = {
      ioId: ++id,
      kind: 'frame-end',
      requestId: ++request,
      rendererId: 1,
      rootEpoch: 1,
      rawOffset: offset,
      geometryId: 0,
    }
    io.push(end)
    frames.push({
      frameId: index + 1,
      broker: { start, end, rootReset: index === 0, cursorVisible: true },
      frameBase64: Buffer.from(JSON.stringify(group.frame)).toString('base64'),
      outputBase64: '',
    })
  }
  io.push({
    ioId: ++id,
    kind: 'eof',
    rawOffset: offset,
    geometryId: 0,
    childStatus: 0,
  })
  const raw = Buffer.concat(chunks),
    captureId = randomUUID()
  io.forEach((event) => (event.captureId = captureId))
  frames.forEach((entry) => {
    entry.captureId = captureId
    entry.pid = 123
  })
  writeFileSync(
    join(run, 'native-pty-initial.json'),
    JSON.stringify({ captureId, pid: 123, pgid: 123, sizeHex: '08000a0000000000' }),
  )
  for (const name of ['pty.raw', 'native-pty.raw'])
    writeFileSync(join(run, name), raw)
  writeFileSync(
    join(run, 'frames.jsonl'),
    frames.map(JSON.stringify).join('\n') + '\n',
  )
  writeFileSync(
    join(run, 'pty-io.jsonl'),
    io.map(JSON.stringify).join('\n') + '\n',
  )
  writeFileSync(
    join(run, 'geometry.jsonl'),
    JSON.stringify({ phase: 'launch', columns: 10, rows: 8 }) + '\n',
  )
  writeFileSync(
    join(run, 'native-pty-eof.json'),
    JSON.stringify({
      captureId,
      childPid: 123,
      rawBytes: offset,
      childExitCode: 0,
      childStatus: 0,
    }),
  )
  return { run, frames, io }
}
afterAll(() =>
  roots.forEach((root) => rmSync(root, { recursive: true, force: true })),
)
test('a forged driver geometry ledger cannot prove actual native resize', async () => {
  const { run } = fixture([{ output: 'AB\r\n', frame: frame('AB') }])
  writeFileSync(join(run, 'geometry.jsonl'),
    JSON.stringify({ phase: 'launch', columns: 99, rows: 8 }) + '\n')
  await expect(verifyPtyTerminalEvidence(run)).rejects.toThrow('geometry')
})

test('zero-write observations compare their logical snapshot before a real intervening resize', async () => {
  const { run, start, end, ack } = zeroWriteResizeFixture()
  const report = await verifyPtyTerminalEvidence(run)
  expect(report.verdict).toBe('passed')
  expect(report.frames).toHaveLength(3)
  expect(report.frames[1]).toMatchObject({ verdict: 'passed', comparisonIoId: start.ioId,
    comparisonPhase: 'before-resize-no-output', outputBytes: 0,
    startGeometryId: 0, endGeometryId: 1, resizeIoIds: [ack.ioId] })
  expect(report.frames[2]).toMatchObject({ verdict: 'passed', columns: 10, rows: 6 })
  expect(start.rawOffset).toBe(end.rawOffset)
})

test('a zero-write snapshot cannot borrow the later resize viewport to obtain a pass', async () => {
  const { run } = zeroWriteResizeFixture({ width: 10, height: 6 })
  const report = await verifyPtyTerminalEvidence(run)
  expect(report.verdict).toBe('failed')
  expect(report.frames[1].verdict).toBe('failed')
  expect(report.frames[1].difference).toContain('viewport')
})

test('zero-write observations still reject changed cells before the intervening resize', async () => {
  const { run, frames } = zeroWriteResizeFixture()
  const middle = JSON.parse(Buffer.from(frames[1].frameBase64, 'base64').toString())
  middle.cells[1][2] = 'X'
  frames[1].frameBase64 = Buffer.from(JSON.stringify(middle)).toString('base64')
  writeFileSync(join(run, 'frames.jsonl'), frames.map(JSON.stringify).join('\n') + '\n')
  const report = await verifyPtyTerminalEvidence(run)
  expect(report.verdict).toBe('failed')
  expect(report.frames[1].difference).toContain('cell 1,0')
})
test('alternate replay compares measured PTY rows separately from the logical sentinel viewport', async () => {
  const { run } = fixture([{ output: '\x1b[?1049h\x1b[HAB',
    frame: { ...frame('AB', { x: 2, y: 0, visible: true }), buffer: 'alternate',
             logicalViewport: { width: 10, height: 9 } } }])
  const report = await verifyPtyTerminalEvidence(run)
  expect(report.verdict).toBe('passed')
  expect(report.frames[0].verdict).toBe('passed')
  const entries = readFileSync(join(run, 'frames.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const wrong = JSON.parse(Buffer.from(entries[0].frameBase64, 'base64').toString())
  wrong.viewport.height = 9
  entries[0].frameBase64 = Buffer.from(JSON.stringify(wrong)).toString('base64')
  writeFileSync(join(run, 'frames.jsonl'), entries.map(JSON.stringify).join('\n') + '\n')
  expect((await verifyPtyTerminalEvidence(run)).verdict).toBe('failed')
})
test('resize receipts must follow their sends and frames must start after the actual ACK', () => {
  const launch = { phase: 'launch', columns: 10, rows: 8 }
  const send = { phase: 'resize-send', actionId: 1, columns: 10, rows: 6, lastObservedIoId: 1 }
  const returned = { phase: 'resize-return', actionId: 1, columns: 10, rows: 6, exitCode: 0 }
  const io = [{ ioId: 1, columns: 10, rows: 8 },
    { kind: 'resize-ack', ioId: 3, geometryId: 1, columns: 10, rows: 6,
      succeeded: true, ioctl: 'TIOCSWINSZ' }]
  const entry = { broker: { start: { ioId: 4, geometryId: 1 }, end: { ioId: 5, geometryId: 1 } },
    frameBase64: Buffer.from(JSON.stringify({ viewport: { width: 10, height: 6 } })).toString('base64') }
  const producer = { sizeHex: '08000a0000000000' }
  expect(verifyGeometryLedger([launch, send, returned], io, [entry], producer).verdict).toBe('passed')
  const overlapping = { ...entry, broker: { ...entry.broker, start: { ioId: 2, geometryId: 0 } } }
  const accepted = []
  for (const [name, ledger, frames] of [
    ['receipt-before-send', [launch, returned, send], [entry]],
    ['frame-start-before-ack', [launch, send, returned], [overlapping]],
  ]) {
    try { verifyGeometryLedger(ledger, io, frames, producer); accepted.push(name) }
    catch (error) { expect(error.message).toContain('geometry') }
  }
  expect(accepted).toEqual([])
})
test('normal replay uses real PTY geometry and an independent prefix root, keeping zero-write frames', async () => {
  const { run } = fixture([
    { output: 'AB\r\n', frame: frame('AB') },
    { output: '', frame: frame('AB') },
  ])
  const result = await verifyPtyTerminalEvidence(run)
  expect(result.verdict).toBe('passed')
  expect(result.frameCount).toBe(2)
  expect(result.frames.map((f) => f.rootRow)).toEqual([1, 1])
  expect(result.frames.map((f) => f.rows)).toEqual([8, 8])
  expect(result.unmappedBytes).toBe(0)
})
test('a wrong intermediate physical frame fails even after a correct final redraw', async () => {
  const { run } = fixture([
    { output: 'AB\r\n', frame: frame('AB') },
    { output: 'X', frame: frame('AB') },
    { output: '\r\x1b[1AAB\r\n', frame: frame('AB') },
  ])
  const result = await verifyPtyTerminalEvidence(run)
  expect(result.verdict).toBe('failed')
  expect(result.frames[1].verdict).toBe('failed')
  expect(result.frames[2].verdict).toBe('passed')
})
test('normal reset reanchors after actual HOME inside the output transaction', async () => {
  const { run } = fixture([
    { output: 'AB\r\n', frame: frame('AB') },
    { output: '\x1b[2J\x1b[3J\x1b[HZZ\r\n', frame: frame('ZZ') },
  ])
  const result = await verifyPtyTerminalEvidence(run)
  expect(result.verdict).toBe('passed')
  expect(result.frames[1].rootRow).toBe(0)
})
test('a reset from a nonzero physical column must await actual clear and HOME, never infer a root from expected cells', async () => {
  const actualHome = fixture([
    { output: '\x1b[2J\x1b[3J\x1b[HAB\r\n', frame: frame('AB') },
  ], 'prefix!')
  const report = await verifyPtyTerminalEvidence(actualHome.run)
  expect(report.verdict).toBe('passed')
  expect(report.frames[0].rootRow).toBe(0)
  const noHome = fixture([
    { output: '\rAB\r\n', frame: frame('AB') },
  ], 'prefix!')
  const failed = await verifyPtyTerminalEvidence(noHome.run)
  expect(failed.verdict).toBe('failed')
  expect(failed.frames[0].difference).toBe('Normal root anchor was lost')
})
test('actual CSI resets retain parser state across PTY reads and support equivalent HOME forms', async () => {
  const split = fixture([
    { output: '\x1b[2J\x1b[3J\x1b[HAB\r\n', frame: frame('AB') },
  ], 'prefix!')
  const index = split.io.findIndex((event) => event.kind === 'output' && event.start === 7)
  const original = split.io[index], cut = original.start + 2
  split.io.splice(index, 1,
    { ...original, end: cut, rawOffset: cut },
    { ...original, start: cut })
  split.io.forEach((event, index) => { event.ioId = index + 1 })
  writeFileSync(join(split.run, 'pty-io.jsonl'), split.io.map(JSON.stringify).join('\n') + '\n')
  writeFileSync(join(split.run, 'frames.jsonl'), split.frames.map(JSON.stringify).join('\n') + '\n')
  expect((await verifyPtyTerminalEvidence(split.run)).verdict).toBe('passed')
  for (const output of [
    '\x1b[2J\x1b[3J\x1b[1;1HAB\r\n',
    '\u009b2J\u009b3J\u009bHAB\r\n',
    // Pinned xterm exits OSC on this ESC/CSI; observe its real semantics.
    '\x1b]0;payload \x1b[2J\x1b[3J\x1b[H\x07AB\r\n',
  ]) {
    const value = fixture([{ output, frame: frame('AB') }], 'prefix!')
    const result = await verifyPtyTerminalEvidence(value.run)
    expect(result.verdict).toBe('passed')
    expect(result.frames[0].rootRow).toBe(0)
  }
})
test('raw mismatch, missing boundary identity and incomplete EOF cannot pass', async () => {
  const mismatch = fixture([{ output: 'AB\r\n', frame: frame('AB') }])
  writeFileSync(join(mismatch.run, 'pty.raw'), 'changed')
  await expect(verifyPtyTerminalEvidence(mismatch.run)).rejects.toThrow(
    'streams differ',
  )
  const forged = fixture([{ output: 'AB\r\n', frame: frame('AB') }])
  forged.frames[0].broker.end.ioId = 999
  writeFileSync(
    join(forged.run, 'frames.jsonl'),
    forged.frames.map(JSON.stringify).join('\n') + '\n',
  )
  await expect(verifyPtyTerminalEvidence(forged.run)).rejects.toThrow(
    'bijection',
  )
  const truncated = fixture([{ output: 'AB\r\n', frame: frame('AB') }])
  writeFileSync(
    join(truncated.run, 'native-pty-eof.json'),
    JSON.stringify({ rawBytes: 1, childExitCode: 0 }),
  )
  await expect(verifyPtyTerminalEvidence(truncated.run)).rejects.toThrow(
    'complete output',
  )
})
test('resize at a shared raw offset takes effect only after its actual broker event', async () => {
  const value = fixture([
    { output: 'AB\r\n', frame: frame('AB') },
    {
      output: '',
      frame: { ...frame('AB'), viewport: { width: 10, height: 6 } },
    },
  ])
  const after = value.frames[0].broker.end.ioId
  value.io.splice(after, 0, {
    kind: 'resize-ack',
    captureId: value.frames[0].captureId,
    rawOffset: value.frames[0].broker.end.rawOffset,
    geometryId: 1,
    columns: 10,
    rows: 6,
    ioctl: 'TIOCSWINSZ',
    succeeded: true,
  })
  value.io.forEach((event, index) => {
    event.ioId = index + 1
    if (index >= after) event.geometryId = 1
  })
  writeFileSync(join(value.run, 'geometry.jsonl'), [
    { phase: 'launch', columns: 10, rows: 8 },
    { phase: 'resize-send', actionId: 1, columns: 10, rows: 6,
      lastObservedIoId: after },
    { phase: 'resize-return', actionId: 1, columns: 10, rows: 6, exitCode: 0 },
  ].map(JSON.stringify).join('\n') + '\n')
  writeFileSync(
    join(value.run, 'pty-io.jsonl'),
    value.io.map(JSON.stringify).join('\n') + '\n',
  )
  writeFileSync(
    join(value.run, 'frames.jsonl'),
    value.frames.map(JSON.stringify).join('\n') + '\n',
  )
  const report = await verifyPtyTerminalEvidence(value.run)
  expect(report.verdict).toBe('passed')
  expect(report.frames.map((entry) => entry.rows)).toEqual([8, 6])
})
test('dropping a bad logical frame cannot hide its independently captured broker transaction', async () => {
  const value = fixture([
    { output: 'AB\r\n', frame: frame('AB') },
    { output: 'X', frame: frame('AB') },
    { output: '\r\x1b[1AAB\r\n', frame: frame('AB') },
  ])
  value.frames.splice(1, 1)
  value.frames[1].frameId = 2
  writeFileSync(
    join(value.run, 'frames.jsonl'),
    value.frames.map(JSON.stringify).join('\n') + '\n',
  )
  await expect(verifyPtyTerminalEvidence(value.run)).rejects.toThrow(
    'bijection',
  )
})
test('plain space foreground has no painted effect, while glyph, background and underline colors stay strict', async () => {
  const styledSpace = {
    ...frame('AB '),
    cells: [...frame('AB').cells, [2, 0, ' ', 1, '\x1b[38;5;246m']],
  }
  expect(
    (
      await verifyPtyTerminalEvidence(
        fixture([{ output: 'AB\r\n', frame: styledSpace }]).run,
      )
    ).verdict,
  ).toBe('passed')
  for (const [char, ansi] of [
    ['A', '\x1b[38;5;246m'],
    [' ', '\x1b[48;5;246m'],
    [' ', '\x1b[4m\x1b[38;5;246m'],
  ]) {
    const wanted = {
      ...frame('AB '),
      cells: [[0, 0, char, 1, ansi], ...frame('AB ').cells.slice(1)],
    }
    expect(
      (
        await verifyPtyTerminalEvidence(
          fixture([{ output: 'AB\r\n', frame: wanted }]).run,
        )
      ).verdict,
    ).toBe('failed')
  }
})
test('logical viewport cannot claim geometry different from the actual native PTY', async () => {
  const value = fixture([
    {
      output: 'AB\r\n',
      frame: { ...frame('AB'), viewport: { width: 10, height: 999 } },
    },
  ])
  const report = await verifyPtyTerminalEvidence(value.run)
  expect(report.verdict).toBe('failed')
  expect(report.frames[0].difference).toContain('viewport')
})
test('sealed proof checks actual native files and independent replay defeats self-consistent forged verdicts', async () => {
  const value = fixture([{ output: 'AB\r\n', frame: frame('AB') }]),
    { run } = value,
    captureId = value.frames[0].captureId
  const binary = Buffer.from('owned validation fixture binary'),
    binarySha256 = createHash('sha256').update(binary).digest('hex')
  mkdirSync(join(run, 'bin'))
  writeFileSync(join(run, 'bin/claude'), binary)
  writeFileSync(
    join(run, 'native-pty-initial.json'),
    JSON.stringify({ captureId, pid: 123, pgid: 123, binarySha256,
      sizeHex: '08000a0000000000' }),
  )
  writeFileSync(
    join(run, 'broker-cleanup.json'),
    JSON.stringify({
      captureId,
      childPid: 123,
      childReaped: true,
      fifoRemoved: ['frame-request.fifo', 'frame-response.fifo'],
    }),
  )
  writeFileSync(join(run, 'initial-termios.txt'), 'fixture flags\n')
  writeFileSync(join(run, 'capture-eof'), '0\n')
  writeFileSync(
    join(run, 'native-input.jsonl'),
    JSON.stringify({
      captureId,
      pid: 123,
      readId: 1,
      representation: 'decoded-utf8',
      hex: '2f65786974',
    }) + '\n',
  )
  writeFileSync(
    join(run, 'inputs.jsonl'),
    [
      {
        phase: 'send',
        actionId: 1,
        hex: '2f65786974',
        args: ['send-keys', '-t', 'mods:0.0', '-l', '/exit'],
      },
      { phase: 'sent', actionId: 1, exitCodes: [0] },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n',
  )
  const launch = {
    run,
    target: 'mods:0.0',
    pane: '%1',
    binarySha256,
    capture: { captureId, nativeJournal: false, initialSize: { columns: 10, rows: 8 } },
  }
  // Synthetic legacy classifier fixture, explicitly enrolled before consumption.
  writeFileSync(join(run, 'capture-launch.json'), JSON.stringify(launch))
  value.io.splice(-1, 0, {
    kind: 'input', captureId, geometryId: 0,
    rawOffset: value.io.at(-1).rawOffset, hex: '2f65786974',
  })
  value.io.forEach((event, index) => { event.ioId = index + 1 })
  writeFileSync(join(run, 'pty-io.jsonl'),
    value.io.map(JSON.stringify).join('\n') + '\n')
  const terminalCapture = await sealBuiltinCapture(launch, 1),
    side = { ...launch, captureId, cleanup: { terminalCapture } }
  expect(validateBuiltinTerminalEvidence(side)).toBe(true)
  const archivedRecheck = await recheckBuiltinSide(side, binarySha256)
  expect(archivedRecheck.verdict).toBe('passed')
  const persistFinal = (recheck) => {
    writeFileSync(join(run, 'capture-launch.json'), JSON.stringify(launch))
    writeFileSync(join(run, 'terminal-capture.json'), JSON.stringify(terminalCapture))
    writeFileSync(join(run, 'independent-pty-checks.json'), JSON.stringify({
      captureIdentityPassed: true,
      side: { run, target: launch.target, pane: launch.pane, binarySha256, captureId,
        cleanup: { terminalCapture } },
      recheck,
    }))
  }
  const verifyFinal = (options = ['--bounded']) => spawnSync(process.execPath, ['--no-env-file',
    new URL('./terminal-capture-driver.mjs', import.meta.url).pathname,
    'verify', join(run, 'capture-launch.json'), ...options], {
    env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: run, TMPDIR: run },
    encoding: 'utf8', timeout: 5000,
  })
  persistFinal(archivedRecheck)
  const sealedNames = [...Object.keys(terminalCapture.files), 'terminal-capture.json',
    'capture-launch.json', 'independent-pty-checks.json']
  const before = sealedNames.map(name => readFileSync(join(run, name)).toString('hex'))
  const accepted = verifyFinal()
  expect(accepted.status).toBe(0)
  expect(JSON.parse(accepted.stdout).verdict).toBe('passed')
  const full = verifyFinal([])
  expect(full.status).toBe(1)
  expect(JSON.parse(full.stdout).boundedVerdict).toBe('passed')
  expect(JSON.parse(full.stdout).fullCoverageVerdict).toBe('not covered')
  expect(sealedNames.map(name => readFileSync(join(run, name)).toString('hex'))).toEqual(before)
  // Synthetic archive classifier, with original launch bytes pinned by the
  // archive receipt. This does not claim complete terminal timing coverage.
  const archiveParent = mkdtempSync(join(tmpdir(), 'sealed-archive-'))
  roots.push(archiveParent)
  const sourceCache = join(archiveParent, 'source'),
    sourceRun = join(sourceCache, 'runs/r-000000000001'),
    archive = join(archiveParent, 'acceptance-cache'),
    archivedRun = join(archive, 'runs/r-000000000001'),
    receiptPath = join(archiveParent, 'builtin-cache-archive.json'),
    remap = (object, source, target) => JSON.parse(JSON.stringify(object).replaceAll(source, target))
  mkdirSync(sourceRun, { recursive: true })
  cpSync(run, sourceRun, { recursive: true })
  const originalLaunch = remap(launch, run, sourceRun)
  writeFileSync(join(sourceRun, 'capture-launch.json'), JSON.stringify(originalLaunch))
  const originalLaunchBytes = readFileSync(join(sourceRun, 'capture-launch.json')),
    receipt = {
      source: sourceCache, archive, archiveComplete: true, sourceFilesStable: true, archiveFilesMatch: true,
      sourceManifest: { 'runs/r-000000000001/capture-launch.json': {
        type: 'file', sha256: createHash('sha256').update(originalLaunchBytes).digest('hex'),
      } },
    }
  cpSync(sourceCache, archive, { recursive: true })
  writeFileSync(receiptPath, JSON.stringify(receipt))
  const archivedSide = remap(side, run, archivedRun)
  expect((await recheckBuiltinSide(archivedSide, binarySha256, receiptPath)).verdict).toBe('passed')
  expect((await recheckBuiltinSide(archivedSide, binarySha256)).verdict).toBe('failed')
  for (const mutate of [
    value => { value.archiveComplete = false },
    value => { value.sourceFilesStable = false },
    value => { value.archiveFilesMatch = false },
    value => { value.source = '/private/tmp/foreign-source' },
    value => { value.archive = '/private/tmp/foreign-archive' },
    value => { value.sourceManifest['runs/r-000000000001/capture-launch.json'].sha256 = '0'.repeat(64) },
  ]) {
    const changed = JSON.parse(JSON.stringify(receipt))
    mutate(changed)
    writeFileSync(receiptPath, JSON.stringify(changed))
    expect((await recheckBuiltinSide(archivedSide, binarySha256, receiptPath)).verdict).toBe('failed')
  }
  expect(readFileSync(join(archivedRun, 'capture-launch.json'))).toEqual(originalLaunchBytes)
  expect(readFileSync(join(sourceRun, 'capture-launch.json'))).toEqual(originalLaunchBytes)
  const streamVerdict = terminalCapture.stream.verdict
  terminalCapture.stream.verdict = 'failed'
  persistFinal(archivedRecheck)
  expect(verifyFinal().status).toBe(1)
  terminalCapture.stream.verdict = streamVerdict
  persistFinal(archivedRecheck)
  for (const name of [
    'native-pty.raw',
    'pty-io.jsonl',
    'native-pty-eof.json',
    'native-input.jsonl',
  ]) {
    const files = { ...terminalCapture.files }
    delete files[name]
    expect(
      validateBuiltinTerminalEvidence({
        ...side,
        cleanup: { terminalCapture: { ...terminalCapture, files } },
      }),
    ).toBe(false)
  }
  expect(validateBuiltinTerminalEvidence({ ...side, pane: '%other' })).toBe(
    false,
  )
  expect(
    validateBuiltinTerminalEvidence({ ...side, captureId: randomUUID() }),
  ).toBe(false)
  const update = (name) => {
    const bytes = readFileSync(join(run, name))
    terminalCapture.files[name] = {
      path: join(run, name),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  for (const name of ['pty.raw', 'native-pty.raw']) {
    writeFileSync(
      join(run, name),
      readFileSync(join(run, name)).toString().replace('AB', 'XY'),
    )
    update(name)
  }
  const physical = JSON.parse(
    readFileSync(join(run, 'frame-physical-report.json'), 'utf8'),
  )
  physical.rawSHA256 = terminalCapture.files['pty.raw'].sha256
  writeFileSync(
    join(run, 'frame-physical-report.json'),
    JSON.stringify(physical),
  )
  update('frame-physical-report.json')
  expect(validateBuiltinTerminalEvidence(side)).toBe(true)
  expect((await recheckBuiltinSide(side, binarySha256)).verdict).toBe('failed')
  persistFinal({ verdict: 'passed', run, captureId, replay: physical })
  const forgedFinal = verifyFinal()
  expect(forgedFinal.status).toBe(1)
  expect(JSON.parse(forgedFinal.stdout).verdict).toBe('failed')
})


function rewriteEvidenceFrame(value, index, change) {
  const row = value.frames[index]
  const snapshot = JSON.parse(Buffer.from(row.frameBase64, 'base64').toString('utf8'))
  change(snapshot)
  row.frameBase64 = Buffer.from(JSON.stringify(snapshot)).toString('base64')
  writeFileSync(join(value.run, 'frames.jsonl'), value.frames.map(JSON.stringify).join('\n') + '\n')
}
test('zero output is a logical observation while real bytes define an output transaction', async () => {
  const value = zeroWriteResizeFixture()
  const report = await verifyPtyTerminalEvidence(value.run)
  expect(report.frames.map(row => row.observationKind)).toEqual([
    'output-transaction', 'logical-observation', 'logical-observation',
  ])
  expect(report.frames[1].outputBytes).toBe(0)
  expect(report.frames[1].externalTransition.rows).toBe(6)
  expect(report.frames[2].rows).toBe(6)
})
for (const [label, change] of [
  ['cursor', snapshot => { snapshot.cursor.x = 3 }],
  ['painted style', snapshot => { snapshot.cells[0][4] = '\x1b[48;5;1m' }],
  ['cell width', snapshot => { snapshot.cells[0][3] = 2 }],
]) {
  test(`zero-output resize observations still reject incorrect ${label}`, async () => {
    const value = zeroWriteResizeFixture()
    rewriteEvidenceFrame(value, 1, change)
    const report = await verifyPtyTerminalEvidence(value.run)
    expect(report.verdict).toBe('failed')
    expect(report.frames[1].verdict).toBe('failed')
    expect(report.frames[2].rows).toBe(6)
  })
}
test('resize effective before frame start cannot validate an older logical snapshot', async () => {
  const value = zeroWriteResizeFixture()
  value.io.splice(value.io.indexOf(value.ack), 1)
  value.io.splice(value.io.indexOf(value.start), 0, value.ack)
  let geometryId = 0
  value.io.forEach((event, index) => {
    event.ioId = index + 1
    if (event.kind === 'resize-ack') geometryId++
    event.geometryId = geometryId
  })
  writeFileSync(join(value.run, 'pty-io.jsonl'), value.io.map(JSON.stringify).join('\n') + '\n')
  writeFileSync(join(value.run, 'frames.jsonl'), value.frames.map(JSON.stringify).join('\n') + '\n')
  writeFileSync(join(value.run, 'geometry.jsonl'), [
    { phase: 'launch', columns: 10, rows: 8 },
    { phase: 'resize-send', actionId: 1, columns: 10, rows: 6,
      lastObservedIoId: value.frames[0].broker.end.ioId },
    { phase: 'resize-return', actionId: 1, columns: 10, rows: 6, exitCode: 0 },
  ].map(JSON.stringify).join('\n') + '\n')
  const report = await verifyPtyTerminalEvidence(value.run)
  expect(report.verdict).toBe('failed')
  expect(report.frames[1].comparisonPhase).toBe('frame-end')
  expect(report.frames[1].difference).toContain('viewport')
})
test('a changed physical buffer remains a zero-output observation failure', async () => {
  const value = zeroWriteResizeFixture()
  rewriteEvidenceFrame(value, 1, snapshot => { snapshot.buffer = 'normal' })
  const report = await verifyPtyTerminalEvidence(value.run)
  expect(report.verdict).toBe('failed')
  expect(report.frames[1].difference).toContain('buffer')
})
test('following logical observation must independently establish the resized geometry', async () => {
  const value = zeroWriteResizeFixture()
  rewriteEvidenceFrame(value, 2, snapshot => { snapshot.viewport = { width: 10, height: 8 } })
  await expect(verifyPtyTerminalEvidence(value.run)).rejects.toThrow('subsequent frame')
})
