import type { ParsedMouse } from '../parse-keypress.js'
import { Event } from './event.js'

export type PointerEventType = 'down' | 'move' | 'up'

/** Raw terminal pointer input, emitted before Ink selection and click handling. */
export class PointerEvent extends Event {
  /** Original parsed SGR mouse input. */
  readonly parsed: ParsedMouse
  /** Normalized pointer phase. */
  readonly type: PointerEventType
  /** Zero-based screen column. */
  readonly col: number
  /** Zero-based screen row. */
  readonly row: number
  /** SGR base button: 0=left, 1=middle, 2=right, 3=none. */
  readonly button: number
  readonly shift: boolean
  readonly alt: boolean
  readonly ctrl: boolean

  constructor(parsed: ParsedMouse) {
    super()
    this.parsed = parsed
    this.type =
      parsed.action === 'release'
        ? 'up'
        : (parsed.button & 0x20) !== 0
          ? 'move'
          : 'down'
    this.col = parsed.col - 1
    this.row = parsed.row - 1
    this.button = parsed.button & 0x03
    this.shift = (parsed.button & 0x04) !== 0
    this.alt = (parsed.button & 0x08) !== 0
    this.ctrl = (parsed.button & 0x10) !== 0
  }
}
