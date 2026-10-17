import { createRequire } from 'node:module'
import type { FrameEvent } from './frame.js'

const functions = {
  cc_terminal_journal_mark: { args: ['u64', 'u64', 'ptr', 'u64'], returns: 'u64' },
} as const

let library: import('bun:ffi').Library<typeof functions> | null | undefined
let spanId = 0

export type NativeTerminalFrameSpan = {
  profile: 'ink-post-write-v1'
  captureId: string | undefined
  spanId: number
  rendererId: number
  rootEpoch: number
  columns: number
  rows: number
}

export function nativeTerminalJournalRequested(): boolean {
  return process.env.CLAUDE_PRIVATE_NATIVE_JOURNAL !== undefined
}

/** Resolve the already enrolled observer before rendering, never in a write span. */
export function initializeNativeTerminalJournal(): void {
  if (library !== undefined || !nativeTerminalJournalRequested()) return
  library = null
  try {
    const path = process.env.CLAUDE_PRIVATE_NATIVE_JOURNAL_LIBRARY
    if (!path || process.platform !== 'darwin') return
    const ffi = createRequire(import.meta.url)('bun:ffi') as typeof import('bun:ffi')
    library = ffi.dlopen(path, functions)
  } catch {
    // Missing records invalidate the independent capture. Observer failure must
    // not replace the application's writes or fall back to a synchronous ACK.
  }
}

function mark(kind: 10 | 11 | 12 | 13, span: NativeTerminalFrameSpan, value: unknown): void {
  if (!library) return
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  library.symbols.cc_terminal_journal_mark(kind, span.spanId, payload, payload.length)
}

export function beginNativeTerminalFrame(
  rendererId: number,
  rootEpoch: number,
  columns: number,
  rows: number,
): NativeTerminalFrameSpan | undefined {
  if (!nativeTerminalJournalRequested()) return undefined
  const span: NativeTerminalFrameSpan = {
    profile: 'ink-post-write-v1',
    captureId: process.env.CLAUDE_CODE_FRAME_CAPTURE_ID,
    spanId: ++spanId, rendererId, rootEpoch, columns, rows,
  }
  mark(10, span, span)
  return span
}

export function nativeTerminalFrameBoundary(
  kind: 'frame-start' | 'frame-end',
  span: NativeTerminalFrameSpan | undefined,
): void {
  if (span) mark(kind === 'frame-start' ? 12 : 13, span, span)
}

/** Serialize before the next render can reuse the screen and its shared pools. */
export function recordNativeTerminalFrame(event: FrameEvent, frameBase64: string): void {
  const span = event.nativeTerminalEvidence
  if (!span) return
  mark(11, span, {
    native: span,
    rootReset: event.nativeTerminalRootReset,
    cursorVisible: event.nativeTerminalCursorVisible,
    terminalPanes: event.terminalPanes,
    terminalUiRevision: event.terminalUiRevision,
    frameBase64,
  })
}
