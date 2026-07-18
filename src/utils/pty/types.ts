export const SESSION_STATES = [
  'starting',
  'running',
  'exited',
  'closed',
  'failed',
] as const

export type TerminalSessionState = (typeof SESSION_STATES)[number]

export const INITIAL_TERMINAL_SIZE = {
  cols: 120,
  rows: 30,
} as const

export const MAX_TERMINAL_SIZE = {
  cols: 1000,
  rows: 1000,
} as const

export const DEFAULT_MAX_BUFFERED_CHUNKS = 200

export const SPECIAL_KEYS = [
  'ENTER',
  'TAB',
  'ESC',
  'BACKSPACE',
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'CTRL_C',
  'CTRL_D',
  'CTRL_L',
] as const

export type TerminalSpecialKey = (typeof SPECIAL_KEYS)[number]

export interface TerminalOutputChunk {
  start: number
  end: number
  text: string
  stream: 'stdout' | 'stderr'
  timestamp: number
}

export interface TerminalReadResult {
  chunks: TerminalOutputChunk[]
  lowestAvailableCursor: number
  nextCursor: number
  truncatedBeforeCursor: boolean
}

export interface TerminalSessionRecord {
  args: string[]
  cols: number
  command: string
  cwd: string
  exitedAt?: number
  exitCode?: number | null
  lastActivityAt: number
  lowestAvailableCursor: number
  nextCursor: number
  pid?: number
  rows: number
  sessionId: string
  signal?: NodeJS.Signals | null
  startedAt: number
  state: TerminalSessionState
  truncatedBeforeCursor: boolean
}

export interface OpenTerminalSessionOptions {
  args?: string[]
  cols?: number
  command?: string
  cwd: string
  env?: Record<string, string>
  rows?: number
}

export interface PtyDriverOpenOptions {
  args: string[]
  cols: number
  command: string
  cwd: string
  env?: Record<string, string>
  rows: number
  sessionId: string
}

export interface PtyDriverSessionStatus {
  exitedAt?: number
  exitCode?: number | null
  pid?: number
  signal?: NodeJS.Signals | null
  state: TerminalSessionState
}

export interface PtyDriver {
  close(sessionId: string): PtyDriverSessionStatus
  dispose?(sessionId: string): void
  kill?(sessionId: string, signal: 'SIGINT' | 'SIGTERM'): PtyDriverSessionStatus
  open(options: PtyDriverOpenOptions): PtyDriverSessionStatus
  resize?(sessionId: string, cols: number, rows: number): void
  status(sessionId: string): PtyDriverSessionStatus
  write(sessionId: string, data: string): Omit<TerminalOutputChunk, 'start' | 'end'> | null
}
