import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { z } from 'zod/v4'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import { getToolResultsDir } from '../../../utils/toolResultStorage.js'
import type { capturePaneActionSchema } from '../actionSchemas.js'
import {
  compactReadOutput,
  truncateUtf8Bytes,
} from '../compressReadOutput.js'

type ReadActionInput = z.infer<typeof capturePaneActionSchema>

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
}

function writeReadSnapshot(target: string, text: string): string {
  const dir = getToolResultsDir()
  mkdirSync(dir, { recursive: true })
  const filePath = join(
    dir,
    `terminal-capture-pane-${safeFilePart(target)}-${Date.now()}.txt`,
  )
  writeFileSync(filePath, text, 'utf8')
  return filePath
}

export function handleRead(manager: PtySessionManager, input: ReadActionInput) {
  const mode = input.mode ?? 'compact'
  const maxBytes = input.maxBytes ?? 8192
  const maxLines = input.maxLines ?? 80
  const maxLineChars = input.maxLineChars ?? 240
  const result = manager.read(input.target, input.cursor)
  const fullText = result.chunks.map(chunk => chunk.text).join('')
  const status = manager.status(input.target)
  const originalBytes = Buffer.byteLength(fullText, 'utf8')
  const base = {
    target: input.target,
    fromCursor: 0,
    toCursor: originalBytes,
    rows: status.rows,
    cols: status.cols,
    isRunning: status.state === 'running',
    exitCode: status.exitCode ?? null,
    truncatedBeforeCursor: result.truncatedBeforeCursor,
  }

  if (mode === 'save_file') {
    const previewCap = input.previewBytes ?? 2000
    const compact = compactReadOutput(fullText, {
      maxBytes: previewCap,
      maxLineChars,
      maxLines,
    })
    const preview = truncateUtf8Bytes(compact.text, previewCap)

    return {
      ...base,
      mode: 'save_file' as const,
      filePath: writeReadSnapshot(input.target, fullText),
      preview,
      previewBytes: Buffer.byteLength(preview, 'utf8'),
      originalBytes,
    }
  }

  if (mode === 'full') {
    const text = truncateUtf8Bytes(fullText, maxBytes)
    return {
      ...base,
      text,
      mode: 'full' as const,
      compressed: false,
      originalBytes,
      returnedBytes: Buffer.byteLength(text, 'utf8'),
    }
  }

  const compact = compactReadOutput(fullText, {
    maxBytes: maxBytes,
    maxLineChars: maxLineChars,
    maxLines: maxLines,
  })

  return {
    ...base,
    text: compact.text,
    mode: 'compact' as const,
    compressed: compact.compressed,
    originalBytes: compact.originalBytes,
    returnedBytes: compact.returnedBytes,
    omittedLines: compact.omittedLines,
    omittedChars: compact.omittedChars,
  }
}
