import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { URL } from 'node:url'
import { createHash } from 'node:crypto'
import * as xterm from '@xterm/headless'
import { screenLines, semanticEvidence } from './terminal-frame-semantics.mjs'
import { captureInputIntent } from './builtin-terminal-evidence.mjs'
import { verifyNativeInputEvents } from './terminal-input-evidence.mjs'

const Terminal =
  xterm.Terminal ?? xterm.default?.Terminal ?? xterm['module.exports']?.Terminal
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const lines = (path) => {
  const text = readFileSync(path, 'utf8')
  if (!text.endsWith('\n')) throw Error(`Unsealed JSONL: ${path}`)
  return text.split('\n').filter(Boolean).map(JSON.parse)
}
const write = (terminal, bytes) =>
  new Promise((resolve) => terminal.write(bytes, resolve))
const style = (cell) =>
  [
    cell.getFgColorMode(),
    cell.getFgColor(),
    cell.getBgColorMode(),
    cell.getBgColor(),
    cell.isBold(),
    cell.isDim(),
    cell.isItalic(),
    cell.isUnderline(),
    cell.isInverse(),
    cell.isInvisible(),
    cell.isStrikethrough(),
    cell.isOverline(),
  ].join(':')
const samePaintedStyle = (actual, wanted, char, width) => {
  if (actual === wanted) return true
  if (char !== ' ' || width !== 1) return false
  const left = actual.split(':'),
    right = wanted.split(':')
  // Ink omits unpainted spaces. Decorations or inverse still make foreground visible.
  if (
    [7, 8, 10, 11].some((index) => left[index] !== '0' || right[index] !== '0')
  )
    return false
  return left[2] === right[2] && left[3] === right[3]
}

export function verifyGeometryLedger(geometry, io, entries, producer) {
  const initial = io[0], launch = geometry[0]
  if (launch?.phase !== 'launch' || launch.columns !== initial.columns ||
      launch.rows !== initial.rows || geometry.filter(row => row.phase === 'launch').length !== 1)
    throw Error('Driver launch geometry differs from measured native geometry')
  const size = Buffer.from(producer.sizeHex ?? '', 'hex')
  if (size.length !== 8 || size.readUInt16LE(0) !== initial.rows ||
      size.readUInt16LE(2) !== initial.columns)
    throw Error('Native initial geometry metadata differs from the actual ioctl')
  const sends = geometry.filter(row => row.phase === 'resize-send'),
    returns = geometry.filter(row => row.phase === 'resize-return'),
    acks = io.filter(row => row.kind === 'resize-ack')
  if (sends.length !== returns.length || sends.length !== acks.length ||
      geometry.length !== 1 + sends.length * 2)
    throw Error('Missing or unrequested native resize geometry')
  for (const [index, send] of sends.entries()) {
    const returned = returns[index], ack = acks[index],
      nextSend = sends[index + 1], nextAck = acks[index + 1]
    if (send.actionId !== index + 1 || returned.actionId !== send.actionId ||
        geometry[index * 2 + 1] !== send || geometry[index * 2 + 2] !== returned ||
        returned.exitCode !== 0 || returned.columns !== send.columns ||
        returned.rows !== send.rows ||
        !Number.isSafeInteger(send.lastObservedIoId) ||
        ack.ioId <= send.lastObservedIoId ||
        ack.columns !== send.columns || ack.rows !== send.rows ||
        ack.succeeded !== true || ack.ioctl !== 'TIOCSWINSZ' ||
        (nextSend && ack.ioId > nextSend.lastObservedIoId) ||
        !entries.some(entry => {
          const start = entry.broker?.start, end = entry.broker?.end
          if (!start || start.ioId <= ack.ioId || start.geometryId !== ack.geometryId ||
              !end || end.ioId <= ack.ioId || end.geometryId !== ack.geometryId ||
              (nextAck && end.ioId >= nextAck.ioId)) return false
          const frame = JSON.parse(Buffer.from(entry.frameBase64, 'base64').toString('utf8'))
          return frame.viewport?.width === ack.columns &&
            frame.viewport?.height === ack.rows
        }))
      throw Error('Resize geometry lacks a causal successful ACK and subsequent frame')
  }
  return { verdict: 'passed', requested: sends.length, acknowledged: acks.length,
    sizes: acks.map(({ columns, rows, ioId, geometryId }) =>
      ({ columns, rows, ioId, geometryId })) }
}

export async function verifyPtyTerminalEvidence(run) {
  const parserSHA256 = hash(readFileSync(new URL(import.meta.resolve('@xterm/headless'))))
  if (parserSHA256 !== '17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed')
    throw Error('Independent terminal parser does not match the pinned oracle')
  const raw = readFileSync(join(run, 'pty.raw')),
    native = readFileSync(join(run, 'native-pty.raw')),
    entries = lines(join(run, 'frames.jsonl')),
    io = lines(join(run, 'pty-io.jsonl'))
  const producer = JSON.parse(
    readFileSync(join(run, 'native-pty-initial.json'), 'utf8'),
  )
  if (
    !producer.captureId ||
    !Number.isInteger(producer.pid) ||
    producer.pid < 1 ||
    producer.pid !== producer.pgid ||
    entries.some(
      (entry) =>
        entry.captureId !== producer.captureId || entry.pid !== producer.pid,
    ) ||
    io.some((event) => event.captureId !== producer.captureId)
  )
    throw Error('Native producer identity does not belong to this capture')
  if (!Terminal || !entries.length || !raw.equals(native))
    throw Error('Missing frames or independent PTY streams differ')
  let rawOffset = 0,
    geometryId = 0
  for (const [index, event] of io.entries()) {
    if (
      event.ioId !== index + 1 ||
      !Number.isSafeInteger(event.rawOffset) ||
      event.rawOffset < rawOffset
    )
      throw Error('Noncontiguous broker event identity or raw offset')
    if (event.kind === 'output') {
      if (
        event.start !== rawOffset ||
        event.end !== event.rawOffset ||
        event.end > raw.length
      )
        throw Error('Dropped, reordered, or unowned PTY output')
      rawOffset = event.end
    } else if (event.rawOffset !== rawOffset)
      throw Error('Boundary did not follow recorded PTY output')
    if (event.kind === 'resize-ack') geometryId++
    if (event.geometryId !== geometryId)
      throw Error('Broker geometry ID is not contiguous')
  }
  const eof = JSON.parse(readFileSync(join(run, 'native-pty-eof.json'), 'utf8'))
  if (
    io.at(-1)?.kind !== 'eof' ||
    rawOffset !== raw.length ||
    eof.rawBytes !== raw.length ||
    eof.childExitCode !== 0 ||
    eof.captureId !== producer.captureId ||
    eof.childPid !== producer.pid
  )
    throw Error('Native PTY did not close normally with complete output')
  const initial = io[0]
  if (
    initial.kind !== 'initial-geometry' ||
    initial.childPid !== producer.pid ||
    !Number.isInteger(initial.columns) ||
    initial.columns < 1 ||
    !Number.isInteger(initial.rows) ||
    initial.rows < 1
  )
    throw Error('No measured native initial geometry')
  const geometryProof = verifyGeometryLedger(
    lines(join(run, 'geometry.jsonl')), io, entries, producer,
  )
  const inputPath = join(run, 'inputs.jsonl')
  let inputProof = { verdict: 'not covered' }, inputsSHA256 = null
  if (existsSync(inputPath)) {
    const input = lines(inputPath), first = input.find(row => row.phase === 'send'),
      intended = captureInputIntent(run, first?.target ?? first?.args?.[2], input)
    if (!intended) throw Error('Driver native input ledger is incomplete or not owned')
    inputProof = await verifyNativeInputEvents(raw, io, intended)
    inputsSHA256 = hash(readFileSync(inputPath))
  } else if (io.some(row => row.kind === 'input'))
    throw Error('Actual native input has no driver receipt ledger')
  const terminal = new Terminal({
    allowProposedApi: true,
    cols: initial.columns,
    rows: initial.rows,
    convertEol: false,
    scrollback: 200000,
    logLevel: 'off',
  })
  const byId = new Map(io.map((event) => [event.ioId, event])),
    roots = new Map(),
    styleCache = new Map(),
    frames = [],
    intervals = []
  const boundaries = io.filter(
    (event) => event.kind === 'frame-start' || event.kind === 'frame-end',
  )
  if (
    boundaries.length !== entries.length * 2 ||
    entries.some(
      (entry, index) =>
        boundaries[index * 2]?.ioId !== entry.broker?.start?.ioId ||
        boundaries[index * 2 + 1]?.ioId !== entry.broker?.end?.ioId,
    )
  )
    throw Error(
      'Logical frames and native broker transactions are not a bijection',
    )
  let offset = 0,
    eventIndex = 0,
    currentRoot
  const wantedStyle = async (ansi) => {
    if (styleCache.has(ansi)) return styleCache.get(ansi)
    const oracle = new Terminal({
      allowProposedApi: true,
      cols: 2,
      rows: 1,
      convertEol: false,
      logLevel: 'off',
    })
    try {
      await write(oracle, Buffer.from(ansi + 'X'))
      const result = style(oracle.buffer.active.getLine(0).getCell(0))
      styleCache.set(ansi, result)
      return result
    } finally {
      oracle.dispose()
    }
  }
  const anchor = (allowDeferred = false) => {
    if (terminal.buffer.active.type === 'alternate') return undefined
    if (terminal.buffer.active.cursorX !== 0) {
      // Leaving alternate screen may restore a mid-row cursor. A declared
      // reset can only acquire its anchor after actual clear/HOME bytes are
      // replayed below; logical cells never determine the physical root.
      if (allowDeferred) return undefined
      throw Error(
        'Normal root lacks an independent cursor-row anchor at column zero',
      )
    }
    const marker = terminal.registerMarker(0)
    if (!marker) throw Error('Normal root cursor-row marker unavailable')
    return marker
  }
  const clearRoots = () => {
    for (const root of roots.values()) root.marker?.dispose()
    roots.clear()
  }
  let clearedForHome = false, semanticError
  const semanticObservers = [
    terminal.parser.registerCsiHandler({ final: 'J' }, (params) => {
      if (params[0] === 2) {
        clearRoots()
        clearedForHome = terminal.buffer.active.type === 'normal'
      }
      return false // Observe the real parser; keep its default ED implementation.
    }),
    terminal.parser.registerCsiHandler({ final: 'H' }, (params) => {
      const isHome = [params[0] ?? 0, params[1] ?? 0].every(value => value === 0 || value === 1)
      if (clearedForHome && isHome && currentRoot && terminal.buffer.active.type === 'normal') {
        if (terminal._core?.coreService?.decPrivateModes?.origin !== false) {
          semanticError = 'Normal reset anchor with unknown or active origin mode is not covered'
        } else {
          // The actual parsed CUP is about to position at the top viewport row.
          // Register that existing physical row before default CUP runs. No
          // wanted cell, logical height or wanted cursor selects this marker.
          currentRoot.marker = terminal.registerMarker(-terminal.buffer.active.cursorY)
          currentRoot.previousRows = 0
          roots.set(currentRoot.key, currentRoot)
          if (!currentRoot.marker) semanticError = 'Parsed HOME cursor-row marker unavailable'
        }
      }
      clearedForHome = false
      return false // CUP still executes through the pinned default parser handler.
    }),
  ]
  const replayBytes = async (bytes) => {
    await write(terminal, bytes)
    if (semanticError) throw Error(semanticError)
  }
  const replayThrough = async (ioId) => {
    if (!Number.isSafeInteger(ioId) || ioId < eventIndex || ioId > io.length)
      throw Error('Invalid native broker event interval')
    while (eventIndex < ioId) {
      const event = io[eventIndex++]
      if (event.kind === 'output') {
        await replayBytes(raw.subarray(offset, event.rawOffset))
        offset = event.rawOffset
      } else if (event.kind === 'resize-ack') {
        if (
          event.succeeded !== true ||
          event.ioctl !== 'TIOCSWINSZ' ||
          !Number.isInteger(event.columns) ||
          event.columns < 1 ||
          !Number.isInteger(event.rows) ||
          event.rows < 1
        )
          throw Error('Invalid native PTY resize ACK')
        terminal.resize(event.columns, event.rows)
      }
    }
  }
  try {
    let previousEnd = 0
    for (const [index, entry] of entries.entries()) {
      const { start, end, rootReset, cursorVisible } = entry.broker ?? {}
      if (
        entry.frameId !== index + 1 ||
        !start ||
        !end ||
        start.kind !== 'frame-start' ||
        end.kind !== 'frame-end' ||
        start.rendererId !== end.rendererId ||
        start.rootEpoch !== end.rootEpoch ||
        start.ioId >= end.ioId ||
        start.rawOffset < previousEnd ||
        end.rawOffset < start.rawOffset ||
        typeof cursorVisible !== 'boolean'
      )
        throw Error('Missing or inconsistent frame/broker identity')
      for (const boundary of [start, end]) {
        const observed = byId.get(boundary.ioId)
        if (
          !observed ||
          [
            'kind',
            'requestId',
            'rendererId',
            'rootEpoch',
            'rawOffset',
            'geometryId',
          ].some((key) => observed[key] !== boundary[key])
        )
          throw Error(
            'Frame boundary does not belong to the captured native PTY',
          )
      }
      currentRoot = undefined
      await replayThrough(start.ioId)
      const frame = JSON.parse(
          Buffer.from(entry.frameBase64, 'base64').toString('utf8'),
        ),
        key = `${start.rendererId}:${start.rootEpoch}`
      if (
        !Number.isInteger(frame.columns) ||
        frame.columns < 0 ||
        !Number.isInteger(frame.rows) ||
        frame.rows < 0 ||
        !Array.isArray(frame.cells) ||
        !['normal', 'alternate'].includes(frame.buffer) ||
        !Number.isInteger(frame.cursor?.x) ||
        !Number.isInteger(frame.cursor?.y)
      )
        throw Error('Malformed logical frame')
      const cellIds = new Set()
      for (const cell of frame.cells) {
        if (
          !Array.isArray(cell) ||
          cell.length !== 5 ||
          !Number.isInteger(cell[0]) ||
          !Number.isInteger(cell[1]) ||
          cell[0] < 0 ||
          cell[0] >= frame.columns ||
          cell[1] < 0 ||
          cell[1] >= frame.rows ||
          typeof cell[2] !== 'string' ||
          ![0, 1, 2].includes(cell[3]) ||
          typeof cell[4] !== 'string' ||
          cellIds.has(`${cell[0]}:${cell[1]}`)
        )
          throw Error('Malformed or duplicated logical cell')
        cellIds.add(`${cell[0]}:${cell[1]}`)
      }
      let root = roots.get(key)
      if (!root) {
        if (frame.buffer === 'normal' && !rootReset)
          throw Error('Normal logical root epoch was not declared')
        root = {
          key,
          marker: frame.buffer === 'normal' ? anchor(true) : undefined,
          previousRows: 0,
        }
        roots.set(key, root)
      }
      currentRoot = root
      const interval = io.slice(start.ioId, end.ioId - 1)
      const resizes = interval.filter(event => event.kind === 'resize-ack')
      const outputBytes = end.rawOffset - start.rawOffset
      if (outputBytes === 0 && interval.some(event => event.kind === 'output' && event.end > event.start))
        throw Error('Zero-write observation contains captured output')
      // A no-write observation cannot publish a new terminal state. Compare its
      // snapshot at start, then replay every intervening external resize.
      const compareBeforeResize = outputBytes === 0 && resizes.length > 0
      if (!compareBeforeResize) await replayThrough(end.ioId)
      const comparisonIoId = compareBeforeResize ? start.ioId : end.ioId
      const comparisonColumns = terminal.cols, comparisonRows = terminal.rows
      const buffer = terminal.buffer.active,
        base = frame.buffer === 'alternate' ? 0 : root.marker?.line
      const comparisonBaseY = buffer.baseY, comparisonViewportY = buffer.viewportY
      let difference
      if (buffer.type !== frame.buffer)
        difference = `buffer ${buffer.type} != ${frame.buffer}`
      else if (
        frame.viewport?.width !== terminal.cols ||
        frame.viewport?.height !== terminal.rows
      )
        difference =
          'physical viewport differs from measured native PTY geometry'
      else if (frame.logicalViewport !== undefined && (
        frame.logicalViewport.width !== terminal.cols ||
        frame.logicalViewport.height !== (frame.buffer === 'alternate' ? terminal.rows + 1 : terminal.rows)
      ))
        difference = 'logical renderer viewport differs from its declared buffer geometry'
      else if (!Number.isSafeInteger(base) || base < 0)
        difference = 'Normal root anchor was lost'
      else if (frame.columns > terminal.cols)
        difference = `logical columns ${frame.columns} exceed PTY ${terminal.cols}`
      else if (
        buffer.cursorX !== frame.cursor.x ||
        buffer.cursorY !== base + frame.cursor.y - buffer.baseY
      )
        difference = `cursor ${buffer.cursorX},${buffer.cursorY} != root(${base}) + ${frame.cursor.x},${frame.cursor.y} - baseY(${buffer.baseY})`
      else if (typeof terminal._core?.coreService?.isCursorHidden !== 'boolean')
        difference = 'Pinned xterm cursor visibility API unavailable'
      else if (!terminal._core.coreService.isCursorHidden !== cursorVisible)
        difference =
          'Producer cursor policy differs from actual terminal visibility'
      const expected = new Map(
        frame.cells.map(([x, y, char, width, ansi = '']) => [
          `${x}:${y}`,
          { char: char || (width === 0 ? '' : ' '), width, ansi },
        ]),
      )
      const height = Math.max(frame.rows, root.previousRows)
      if (!difference)
        for (let y = 0; y < height && !difference; y++) {
          const line = buffer.getLine(base + y)
          if (!line) {
            difference = `Missing physical root row ${base + y}`
            break
          }
          for (let x = 0; x < terminal.cols; x++) {
            const cell = line.getCell(x),
              wanted = expected.get(`${x}:${y}`) ?? {
                char: ' ',
                width: 1,
                ansi: '',
              }
            if (!cell) {
              difference = `Missing physical cell ${x},${base + y}`
              break
            }
            const actualChar =
              cell.getChars() || (cell.getWidth() === 0 ? '' : ' ')
            if (
              actualChar !== wanted.char ||
              cell.getWidth() !== wanted.width
            ) {
              difference = `cell ${x},${y}: ${JSON.stringify(wanted)} != ${JSON.stringify({ char: actualChar, width: cell.getWidth() })}`
              break
            }
            const lead = expected.get(`${x - 1}:${y}`)
            const ansi =
              wanted.width === 0 && lead?.width === 2 ? lead.ansi : wanted.ansi
            if (
              !samePaintedStyle(
                style(cell),
                await wantedStyle(ansi),
                wanted.char,
                wanted.width,
              )
            ) {
              difference = `cell ${x},${y} style differs`
              break
            }
          }
        }
      root.previousRows = frame.rows
      if (compareBeforeResize) await replayThrough(end.ioId)
      intervals.push({
        frameId: entry.frameId,
        start: start.rawOffset,
        end: end.rawOffset,
        startIoId: start.ioId,
        endIoId: end.ioId,
      })
      frames.push({
        frameId: entry.frameId,
        rendererId: start.rendererId,
        rootEpoch: start.rootEpoch,
        columns: comparisonColumns,
        rows: comparisonRows,
        logicalRows: frame.rows,
        rootRow: base,
        baseY: comparisonBaseY,
        viewportY: comparisonViewportY,
        comparisonIoId,
        observationKind: outputBytes === 0 ? 'logical-observation' : 'output-transaction',
        comparisonPhase: compareBeforeResize ? 'before-resize-no-output' : 'frame-end',
        outputBytes,
        startGeometryId: start.geometryId,
        endGeometryId: end.geometryId,
        resizeIoIds: resizes.map(event => event.ioId),
        ...(compareBeforeResize ? { externalTransition: {
          endIoId: end.ioId, columns: terminal.cols, rows: terminal.rows,
          buffer: terminal.buffer.active.type, rootRow: root.marker?.line,
          baseY: terminal.buffer.active.baseY, viewportY: terminal.buffer.active.viewportY,
          cursor: { x: terminal.buffer.active.cursorX, y: terminal.buffer.active.cursorY },
        } } : {}),
        verdict: difference ? 'failed' : 'passed',
        difference,
        semantic: semanticEvidence(screenLines(frame)),
      })
      previousEnd = end.rawOffset
    }
    currentRoot = undefined
    await replayThrough(io.length)
    return {
      method: 'independent-pty-replay-v1',
      verdict: frames.every((frame) => frame.verdict === 'passed')
        ? 'passed'
        : 'failed',
      parserSHA256,
      rootAnchoring: 'actual parsed ED and HOME, across native read chunks; normal marker from the physical cursor row',
      initialSize: { columns: initial.columns, rows: initial.rows },
      geometryProof,
      inputProof,
      inputsSHA256,
      styleComparison:
        'painted cell effects; plain-space foreground/bold/dim/italic/invisibility ignored; background and decorated spaces remain strict',
      frameCount: frames.length,
      sizeSequence: frames.filter((frame, index) => !index ||
        frame.columns !== frames[index - 1].columns || frame.rows !== frames[index - 1].rows)
        .map(({ columns, rows, frameId }) => ({ columns, rows, frameId })),
      rawSHA256: hash(raw),
      framesSHA256: hash(readFileSync(join(run, 'frames.jsonl'))),
      geometrySHA256: hash(readFileSync(join(run, 'geometry.jsonl'))),
      ioSHA256: hash(readFileSync(join(run, 'pty-io.jsonl'))),
      rawBytes: raw.length,
      unmappedBytes: 0,
      intervals,
      frames,
      scope:
        'cell/style/cursor comparison for declared Ink roots; complete raw event replay; tail semantics and non-Ink output regions require separate assertions',
    }
  } finally {
    for (const observer of semanticObservers) observer.dispose()
    clearRoots()
    terminal.dispose()
  }
}

if (import.meta.main) {
  const [run, output] = process.argv.slice(2)
  if (!run || !output)
    throw Error('Usage: verify-pty-terminal-evidence.mjs RUN_DIR OUTPUT.json')
  let report
  try {
    report = await verifyPtyTerminalEvidence(run)
  } catch (error) {
    report = {
      method: 'independent-pty-replay-v1',
      verdict: 'failed',
      error: error.message,
    }
  }
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  })
  if (report.verdict !== 'passed') process.exitCode = 1
}
