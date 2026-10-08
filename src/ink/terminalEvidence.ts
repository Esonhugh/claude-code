import {
  appendFileSync,
  constants,
  openSync,
  readSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { FrameEvent } from './frame.js'
import { cellAt, CellWidth } from './screen.js'

export type TerminalEvidenceBoundary = {
  ioId: number
  kind: 'frame-start' | 'frame-end'
  requestId: number
  rendererId: number
  rootEpoch: number
  rawOffset: number
  geometryId: number
}

let rendererId = 0
let requestId = 0
let requestFd: number | undefined
let responseFd: number | undefined
let cursorVisible = true
let inputReadId = 0

export function nextEvidenceRendererId(): number {
  return ++rendererId
}

export function setEvidenceCursorVisible(visible: boolean): void {
  cursorVisible = visible
}

export function getEvidenceCursorVisible(): boolean {
  return cursorVisible
}

export function recordEvidenceInputRead(chunk: string): void {
  const directory = process.env.CLAUDE_CODE_FRAME_BROKER_DIR
  if (!directory) return
  appendFileSync(
    join(directory, 'native-input.jsonl'),
    JSON.stringify({
      captureId: process.env.CLAUDE_CODE_FRAME_CAPTURE_ID,
      readId: ++inputReadId,
      pid: process.pid,
      representation: 'decoded-utf8',
      hex: Buffer.from(chunk, 'utf8').toString('hex'),
    }) + '\n',
    { mode: 0o600 },
  )
}

/** Evidence-only synchronous boundary; the broker drains the actual PTY before ACK. */
export function terminalEvidenceBoundary(
  kind: TerminalEvidenceBoundary['kind'],
  renderer: number,
  rootEpoch: number,
): TerminalEvidenceBoundary | undefined {
  const directory = process.env.CLAUDE_CODE_FRAME_BROKER_DIR
  if (!directory) return undefined
  requestFd ??= openSync(
    join(directory, 'frame-request.fifo'),
    constants.O_RDWR | constants.O_NONBLOCK,
  )
  responseFd ??= openSync(
    join(directory, 'frame-response.fifo'),
    constants.O_RDWR | constants.O_NONBLOCK,
  )
  const currentRequestId = ++requestId
  const message = Buffer.from(
    JSON.stringify({
      kind,
      requestId: currentRequestId,
      rendererId: renderer,
      rootEpoch,
    }) + '\n',
  )
  if (writeSync(requestFd, message) !== message.length)
    throw new Error('Incomplete terminal evidence boundary request')
  const deadline = Date.now() + 1000
  const wait = new Int32Array(new SharedArrayBuffer(4))
  const byte = Buffer.alloc(1)
  let reply = ''
  while (Date.now() < deadline) {
    try {
      if (readSync(responseFd, byte, 0, 1, null) === 0)
        throw new Error('Terminal evidence broker closed before ACK')
      if (byte[0] !== 10) {
        reply += byte.toString('utf8')
        if (reply.length > 4096)
          throw new Error('Oversized terminal evidence acknowledgement')
        continue
      }
      const result = JSON.parse(reply) as TerminalEvidenceBoundary
      if (
        result.kind !== kind ||
        result.requestId !== currentRequestId ||
        result.rendererId !== renderer ||
        result.rootEpoch !== rootEpoch ||
        !Number.isSafeInteger(result.rawOffset) ||
        result.rawOffset < 0 ||
        !Number.isSafeInteger(result.ioId) ||
        !Number.isSafeInteger(result.geometryId)
      )
        throw new Error('Terminal evidence acknowledgement identity mismatch')
      return result
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
      Atomics.wait(wait, 0, 0, 1)
    }
  }
  throw new Error('Terminal evidence boundary acknowledgement timed out')
}

export function serializeValidationFrame(
  frame: NonNullable<FrameEvent['frame']>,
  physicalCursor: FrameEvent['physicalCursor'],
  terminalBuffer: FrameEvent['terminalBuffer'],
  terminalViewport: FrameEvent['terminalViewport'],
): string {
  const cells: Array<[number, number, string, number, string]> = []
  for (let y = 0; y < frame.screen.height; y++) {
    for (let x = 0; x < frame.screen.width; x++) {
      const cell = cellAt(frame.screen, x, y)
      if (!cell) continue
      cells.push([
        x,
        y,
        cell.char,
        cell.width === CellWidth.Wide
          ? 2
          : cell.width === CellWidth.Narrow
            ? 1
            : 0,
        cell.styleId === frame.screen.emptyStyleId
          ? ''
          : frame.screen.stylePool.transition(
              frame.screen.stylePool.none,
              cell.styleId,
            ),
      ])
    }
  }
  return Buffer.from(
    JSON.stringify({
      columns: frame.screen.width,
      rows: frame.screen.height,
      viewport: terminalViewport,
      logicalViewport: frame.viewport,
      cursor: physicalCursor ?? frame.cursor,
      buffer: terminalBuffer ?? 'normal',
      cells,
    }),
  ).toString('base64')
}

let evidenceFrameId = 0
export function recordTerminalEvidenceFrame(event: FrameEvent): void {
  const path = process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH
  if (!path || !event.frame || !event.terminalEvidence) return
  if (evidenceFrameId === 0)
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 })
  appendFileSync(
    path,
    JSON.stringify({
      captureId: process.env.CLAUDE_CODE_FRAME_CAPTURE_ID,
      pid: process.pid,
      frameId: ++evidenceFrameId,
      timestamp: Date.now(),
      broker: event.terminalEvidence,
      terminalPanes: event.terminalPanes,
      terminalUiRevision: event.terminalUiRevision,
      outputBase64: '',
      frameBase64: serializeValidationFrame(
        event.frame,
        {
          ...(event.physicalCursor ?? event.frame.cursor),
          visible: event.terminalEvidence.cursorVisible,
        },
        event.terminalBuffer,
        event.terminalViewport,
      ),
    }) + '\n',
  )
}
