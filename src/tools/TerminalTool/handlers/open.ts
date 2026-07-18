import type { z } from 'zod/v4'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import { normalizeTerminalPreview } from '../../../utils/pty/previewText.js'
import type { newSessionActionSchema } from '../actionSchemas.js'

type NewSessionActionInput = z.infer<typeof newSessionActionSchema>

export async function handleOpen(manager: PtySessionManager, input: NewSessionActionInput) {
  const record = manager.open({
    command: input.command,
    args: input.args,
    cwd: input.cwd || process.cwd(),
    env: input.env,
    cols: input.cols,
    rows: input.rows,
  })

  await new Promise(resolve => setTimeout(resolve, 150))
  const initialRead = manager.read(record.sessionId, 0)
  const preview = normalizeTerminalPreview(
    initialRead.chunks.map(chunk => chunk.text).join(''),
  )

  return {
    sessionId: record.sessionId,
    command: record.command,
    args: record.args,
    isRunning: record.state === 'running',
    cols: record.cols,
    rows: record.rows,
    pid: record.pid ?? null,
    preview,
  }
}
