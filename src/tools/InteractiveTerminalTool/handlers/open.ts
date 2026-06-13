import type { z } from 'zod/v4'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import { normalizeTerminalPreview } from '../../../utils/pty/previewText.js'
import { resolveInteractiveTerminalCommand } from '../../../utils/shell/resolveDefaultShell.js'
import type { openActionSchema } from '../actionSchemas.js'

type OpenActionInput = z.infer<typeof openActionSchema>

export async function handleOpen(manager: PtySessionManager, input: OpenActionInput) {
  const command = input.command ?? resolveInteractiveTerminalCommand()
  const record = manager.open({
    command,
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
    command,
    isRunning: record.state === 'running',
    cols: record.cols,
    rows: record.rows,
    pid: record.pid ?? null,
    preview,
  }
}
