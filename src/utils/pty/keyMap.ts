import type { TerminalSpecialKey } from './types.ts'

const KEY_TO_SEQUENCE: Record<TerminalSpecialKey, string> = {
  ENTER: '\r',
  TAB: '\t',
  ESC: '',
  BACKSPACE: '',
  UP: '[A',
  DOWN: '[B',
  LEFT: '[D',
  RIGHT: '[C',
  CTRL_C: '',
  CTRL_D: '',
  CTRL_L: '',
}

export function keyToSequence(key: TerminalSpecialKey): string {
  const sequence = KEY_TO_SEQUENCE[key]
  if (!sequence) {
    throw new Error(`Unsupported terminal key: ${key}`)
  }

  return sequence
}
