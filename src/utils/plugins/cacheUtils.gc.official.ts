// Producer-name oracle checked against fixed Claude Code 2.1.292 Iet/eir.
// The exported aliases retain the fixture contract; the 292 grammar is unchanged.
// It supplies the timestamp/random boundary oracle; no official CLI is executed.
export function FXe(source: string): string {
  const random = Math.random().toString(36).slice(2, 8).padEnd(1, '0')
  return `temp_${source}_${Date.now()}_${random}`
}
export const KYn = /^temp_(?:local|npm|github|git|subdir|archive|command|unknown)_(\d{10,})_[a-z0-9]{1,6}(?:_x|\.clone)?$/
