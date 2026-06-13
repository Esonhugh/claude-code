import type { z } from 'zod/v4'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import type { readActionSchema } from '../actionSchemas.js'

type ReadActionInput = z.infer<typeof readActionSchema>

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) {
    return text
  }

  let end = maxBytes
  while (end > 0) {
    const decoded = buffer.subarray(0, end).toString('utf8')
    if (!decoded.includes('�')) {
      return decoded
    }
    end -= 1
  }
  return ''
}

export function handleRead(manager: PtySessionManager, input: ReadActionInput) {
  const result = manager.read(input.sessionId, input.cursor)
  const text = truncateUtf8(
    result.chunks.map(chunk => chunk.text).join(''),
    input.maxBytes,
  )

  const status = manager.status(input.sessionId)
  const toCursor = input.cursor + Buffer.byteLength(text, 'utf8')

  return {
    sessionId: input.sessionId,
    fromCursor: input.cursor,
    toCursor,
    text,
    rows: status.rows,
    cols: status.cols,
    isRunning: status.state === 'running',
    exitCode: status.exitCode ?? null,
    truncatedBeforeCursor: result.truncatedBeforeCursor,
  }
}
