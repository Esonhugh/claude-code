/**
 * Sync file-read path, extracted from file.ts.
 *
 * file.ts sits in the settings SCC via log.ts → types/logs.ts → types/message.ts →
 * Tool.ts → commands.ts → … Anything that needs readFileSync from file.ts
 * pulls in the whole chain. This leaf imports only fsOperations and debug,
 * both of which terminate in Node builtins.
 *
 * detectFileEncoding/detectLineEndings stay in file.ts — they call logError
 * (log.ts → SCC) on unexpected failures. The -ForResolvedPath/-ForString
 * helpers here are the pure parts; callers who need the logging wrappers
 * import from file.ts.
 */

import { isUtf8 } from 'node:buffer'
import { logForDebugging } from './debug.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'

export type LineEndingType = 'CRLF' | 'LF'

export function detectEncodingForResolvedPath(
  resolvedPath: string,
): BufferEncoding {
  const { buffer, bytesRead } = getFsImplementation().readSync(resolvedPath, {
    length: 4096,
  })

  // Empty files should default to utf8, not ascii
  // This fixes a bug where writing emojis/CJK to empty files caused corruption
  if (bytesRead === 0) {
    return 'utf8'
  }

  if (bytesRead >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le'
  }

  if (
    bytesRead >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return 'utf8'
  }

  // For non-empty files, default to utf8 since it's a superset of ascii
  // and handles all Unicode characters properly
  return 'utf8'
}

/** Why a file is not text that Edit/Write/NotebookEdit can safely rewrite. */
export type NotTextKind = 'not_utf8' | 'nul' | 'utf16be'

const NOT_TEXT_REASONS: Record<NotTextKind, string> = {
  not_utf8:
    'is not valid UTF-8: it uses a legacy encoding such as Windows-1252, Shift-JIS or GBK, or it is binary',
  nul: 'has NUL bytes in its first 8 KB: binary data, UTF-16/UTF-32 without a byte-order mark, or text with embedded NULs',
  utf16be:
    'is UTF-16 big-endian (it starts FE FF), which these tools cannot write',
}

/** Like 2.1.311: UTF-16LE behind its BOM is text; anything else must be UTF-8. */
export function detectNotText(buffer: Buffer): NotTextKind | undefined {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return undefined
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return 'utf16be'
  }
  if (buffer.subarray(0, 8000).includes(0)) return 'nul'
  return isUtf8(buffer) ? undefined : 'not_utf8'
}

export function notTextMessage(kind: NotTextKind): string {
  return `File ${NOT_TEXT_REASONS[kind]}. These tools write UTF-8 (or UTF-16LE behind its byte-order mark) and never convert a file's encoding on their own, so nothing was written. If the file is text, make the change with a shell command that reads and writes it in its own encoding (iconv, or PowerShell Get-Content/Set-Content -Encoding), or ask the user whether to convert it to UTF-8 first. To replace the whole file with new UTF-8 text anyway, delete it first, then Write it.`
}

export function detectLineEndingsForString(content: string): LineEndingType {
  let crlfCount = 0
  let lfCount = 0

  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      if (i > 0 && content[i - 1] === '\r') {
        crlfCount++
      } else {
        lfCount++
      }
    }
  }

  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/**
 * Like readFileSync but also returns the detected encoding and original line
 * ending style in one filesystem pass. Callers writing the file back (e.g.
 * FileEditTool) can reuse these instead of calling detectFileEncoding /
 * detectLineEndings separately, which would each redo safeResolvePath +
 * readSync(4KB).
 */
export function readFileSyncWithMetadata(filePath: string): {
  content: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  notText?: NotTextKind
} {
  const fs = getFsImplementation()
  const { resolvedPath, isSymlink } = safeResolvePath(fs, filePath)

  if (isSymlink) {
    logForDebugging(`Reading through symlink: ${filePath} -> ${resolvedPath}`)
  }

  const bytes = fs.readFileBytesSync(resolvedPath)
  const encoding: BufferEncoding =
    bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf16le'
      : 'utf8'
  const raw = bytes.toString(encoding)
  const notText = detectNotText(bytes)
  // Detect line endings from the raw head before CRLF normalization erases
  // the distinction. 4096 code units is ≥ detectLineEndings's 4096-byte
  // readSync sample (line endings are ASCII, so the unit mismatch is moot).
  const lineEndings = detectLineEndingsForString(raw.slice(0, 4096))
  return {
    content: raw.replaceAll('\r\n', '\n'),
    encoding,
    lineEndings,
    ...(notText && { notText }),
  }
}

export function readFileSync(filePath: string): string {
  return readFileSyncWithMetadata(filePath).content
}
