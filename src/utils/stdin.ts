import { createReadStream, fstatSync, type ReadStream } from 'node:fs'

/** Preserve redirected input while startup awaits before consuming it. */
export function getStdinStream(): NodeJS.ReadStream | ReadStream {
  const stdin = process.stdin
  if (!fstatSync(stdin.fd).isFile()) return stdin
  // Bun's stdin iterator may report EOF without reading a regular file.
  // Keep fd 0 owned by the process, including when iteration is cancelled.
  return createReadStream('', { fd: stdin.fd, autoClose: false, encoding: 'utf8' })
}
