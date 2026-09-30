import type { IBufferCell } from '@xterm/headless'
import { Writable } from 'node:stream'
import type { Frame, FrameEvent } from '../../ink/frame.js'
import { cellAt, CellWidth } from '../../ink/screen.js'
import {
  applyTerminalOutput,
  createTerminalScreenRenderer,
  resizeTerminalScreenRenderer,
  type TerminalScreenRenderer,
} from '../../utils/pty/terminalScreenRenderer.js'

export type FrozenCell = {
  char: string
  width: number
  style: string
}

export type FrozenScreen = {
  columns: number
  rows: number
  cells: FrozenCell[][]
  cursor: { x: number; y: number; visible?: boolean }
  buffer?: 'normal' | 'alternate'
  baseY?: number
  viewportY?: number
}

export type RecordedWrite = {
  id: number
  eventId: number
  bytes: Buffer
  screen?: FrozenScreen
}

export type RecordedFrame = {
  id: number
  eventId: number
  writeId: number
  commit?: string
  event: FrameEvent
  screen: FrozenScreen
}

export type RecordedHarnessEvent =
  | { id: number; kind: 'write'; writeId: number }
  | { id: number; kind: 'frame'; frameId: number; writeId: number }
  | { id: number; kind: 'resize'; columns: number; rows: number }
  | {
      id: number
      kind: 'input' | 'backend' | 'controller' | 'commit'
      detail: string
    }

type RecordedHarnessEventInput =
  | { kind: 'write'; writeId: number }
  | { kind: 'frame'; frameId: number; writeId: number }
  | { kind: 'resize'; columns: number; rows: number }
  | {
      kind: 'input' | 'backend' | 'controller' | 'commit'
      detail: string
    }

export class DiffTerminalOutput extends Writable {
  columns: number
  rows: number
  isTTY = true
  readonly renderer: TerminalScreenRenderer
  readonly writes: RecordedWrite[] = []
  readonly events: RecordedHarnessEvent[] = []
  private parseTail = Promise.resolve()
  private nextWriteId = 1
  private nextEventId = 1

  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
    this.renderer = createTerminalScreenRenderer(columns, rows)
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    const bytes = Buffer.from(chunk)
    const id = this.nextWriteId++
    const write: RecordedWrite = {
      id,
      eventId: this.recordEvent({ kind: 'write', writeId: id }),
      bytes,
    }
    this.writes.push(write)
    this.parseTail = this.parseTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.renderer.terminal.write(bytes.toString('utf8'), () => {
            try {
              write.screen = freezeTerminalScreen(this.renderer)
              resolve()
            } catch (error) {
              reject(error)
            }
          })
        }),
    )
    done()
  }

  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.parseTail = this.parseTail.then(() => {
      resizeTerminalScreenRenderer(this.renderer, columns, rows)
    })
    this.recordEvent({ kind: 'resize', columns, rows })
    this.emit('resize')
  }

  mark(
    kind: Extract<
      RecordedHarnessEvent,
      { kind: 'input' | 'backend' | 'controller' | 'commit' }
    >['kind'],
    detail: string,
  ): number {
    return this.recordEvent({ kind, detail })
  }

  recordFrame(frameId: number, writeId: number): number {
    return this.recordEvent({ kind: 'frame', frameId, writeId })
  }

  async flush(): Promise<void> {
    await this.parseTail
  }

  get lastWriteId(): number {
    return this.writes.at(-1)?.id ?? 0
  }

  screenAfter(writeId: number): FrozenScreen | undefined {
    if (writeId === 0) return freezeTerminalScreen(this.renderer)
    return this.writes.find(write => write.id === writeId)?.screen
  }

  private recordEvent(event: RecordedHarnessEventInput): number {
    const id = this.nextEventId++
    this.events.push({ id, ...event } as RecordedHarnessEvent)
    return id
  }
}

export function createFrameRecorder(
  output: DiffTerminalOutput,
  getFrame: () => Frame,
  getCommit?: () => string | undefined,
): {
  frames: RecordedFrame[]
  onFrame: (event: FrameEvent) => void
} {
  const frames: RecordedFrame[] = []
  return {
    frames,
    onFrame: event => {
      const id = frames.length + 1
      const writeId = output.lastWriteId
      const frame = event.frame ?? getFrame()
      const screen = freezeInkFrame(frame)
      if (event.physicalCursor) screen.cursor = { ...event.physicalCursor }
      frames.push({
        id,
        eventId: output.recordFrame(id, writeId),
        writeId,
        commit: getCommit?.(),
        event,
        screen,
      })
    },
  }
}

export function freezeInkFrame(frame: Frame): FrozenScreen {
  const cells: FrozenCell[][] = []
  for (let y = 0; y < frame.screen.height; y++) {
    const row: FrozenCell[] = []
    for (let x = 0; x < frame.screen.width; x++) {
      const cell = cellAt(frame.screen, x, y)!
      row.push({
        char: cell.char,
        width:
          cell.width === CellWidth.Wide
            ? 2
            : cell.width === CellWidth.Narrow
              ? 1
              : 0,
        style: String(cell.styleId),
      })
    }
    cells.push(row)
  }
  return {
    columns: frame.screen.width,
    rows: frame.screen.height,
    cells,
    cursor: { ...frame.cursor },
  }
}

export function freezeTerminalScreen(
  renderer: TerminalScreenRenderer,
): FrozenScreen {
  const terminal = renderer.terminal
  const buffer = terminal.buffer.active
  const reusable = buffer.getNullCell()
  const cells: FrozenCell[][] = []
  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y)
    const row: FrozenCell[] = []
    for (let x = 0; x < terminal.cols; x++) {
      const cell = line?.getCell(x, reusable)
      row.push(cell ? freezeTerminalCell(cell) : blankCell())
    }
    cells.push(row)
  }
  return {
    columns: terminal.cols,
    rows: terminal.rows,
    cells,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
    buffer: buffer.type,
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
  }
}

export function firstScreenDifference(
  expected: FrozenScreen,
  actual: FrozenScreen,
  expectedFrame?: Frame,
): string | undefined {
  if (expected.columns !== actual.columns || expected.rows !== actual.rows) {
    return `dimensions ${expected.columns}x${expected.rows} !== ${actual.columns}x${actual.rows}`
  }
  if (actual.buffer !== undefined && actual.buffer !== 'alternate') {
    return `buffer ${actual.buffer} !== alternate`
  }
  if (actual.baseY !== undefined && actual.baseY !== 0) {
    return `baseY ${actual.baseY} !== 0`
  }
  if (actual.viewportY !== undefined && actual.viewportY !== 0) {
    return `viewportY ${actual.viewportY} !== 0`
  }
  if (
    expected.cursor.x !== actual.cursor.x ||
    expected.cursor.y !== actual.cursor.y
  ) {
    return `cursor ${expected.cursor.x},${expected.cursor.y} !== ${actual.cursor.x},${actual.cursor.y}`
  }
  const difference = firstCellDifference(expected, actual, expectedFrame)
  return difference
    ? `cell ${difference.x},${difference.y}: ${JSON.stringify(difference.expected)} !== ${JSON.stringify(difference.actual)}`
    : undefined
}

export function firstCellDifference(
  expected: FrozenScreen,
  actual: FrozenScreen,
  expectedFrame?: Frame,
): { x: number; y: number; expected: FrozenCell; actual: FrozenCell } | undefined {
  const rows = Math.max(expected.rows, actual.rows)
  const columns = Math.max(expected.columns, actual.columns)
  const styleCache = new Map<number, string>()
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const left = expected.cells[y]?.[x] ?? blankCell()
      const right = actual.cells[y]?.[x] ?? blankCell()
      if (left.char !== right.char || left.width !== right.width) {
        return { x, y, expected: left, actual: right }
      }
      if (expectedFrame) {
        const styleId = Number(left.style)
        let normalized = styleCache.get(styleId)
        if (normalized === undefined) {
          normalized = terminalStyleFromAnsi(
            expectedFrame.screen.stylePool.transition(
              expectedFrame.screen.stylePool.none,
              styleId,
            ),
          )
          styleCache.set(styleId, normalized)
        }
        if (normalized !== right.style) {
          return {
            x,
            y,
            expected: { ...left, style: normalized },
            actual: right,
          }
        }
      }
    }
  }
  return undefined
}

export function screenLines(screen: FrozenScreen): string[] {
  return screen.cells.map(row =>
    row
      .map(cell => (cell.width === 0 ? '' : cell.char || ' '))
      .join('')
      .trimEnd(),
  )
}

const terminalStyleCache = new Map<string, string>()

function terminalStyleFromAnsi(ansi: string): string {
  const cached = terminalStyleCache.get(ansi)
  if (cached !== undefined) return cached
  const renderer = createTerminalScreenRenderer(2, 1)
  applyTerminalOutput(renderer, `${ansi}X`)
  const cell = renderer.terminal.buffer.active.getLine(0)?.getCell(0)
  const style = cell ? freezeTerminalCell(cell).style : blankCell().style
  renderer.terminal.dispose()
  terminalStyleCache.set(ansi, style)
  return style
}

function freezeTerminalCell(cell: IBufferCell): FrozenCell {
  return {
    char: cell.getChars() || (cell.getWidth() === 0 ? '' : ' '),
    width: cell.getWidth(),
    style: [
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
    ].join(':'),
  }
}

function blankCell(): FrozenCell {
  return { char: ' ', width: 1, style: '0' }
}
