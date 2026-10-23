export type ServerLogger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

/** Line logger for `claude server`. Callers must never pass the auth token. */
export function createServerLogger(
  stream: { write: (chunk: string) => unknown } = process.stderr,
): ServerLogger {
  const log = (level: string) => (message: string) => {
    stream.write(`${new Date().toISOString()} ${level} ${message}\n`)
  }
  return { info: log('INFO'), warn: log('WARN'), error: log('ERROR') }
}
