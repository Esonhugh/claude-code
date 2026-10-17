import { createHash } from 'crypto'

// Kept outside changeDetector to avoid the settings → hooks → settings cycle.
const writes = new Map<string, { identity: string; timestamp: number }>()

export function settingsContentIdentity(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

export function markInternalWrite(path: string, content: string): void {
  writes.set(path, {
    identity: settingsContentIdentity(content),
    timestamp: Date.now(),
  })
}

/** Only suppress the actual written bytes; time bounds marker retention. */
export function consumeInternalWrite(
  path: string,
  identity: string | null,
  windowMs: number,
): boolean {
  const write = writes.get(path)
  writes.delete(path)
  return (
    write !== undefined &&
    Date.now() - write.timestamp < windowMs &&
    write.identity === identity
  )
}

export function clearInternalWrites(): void {
  writes.clear()
}
