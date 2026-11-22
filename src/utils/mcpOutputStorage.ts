import { writeFile } from 'fs/promises'
import { join } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { MCPResultType } from '../services/mcp/client.js'
import { getDefaultFileReadingLimits } from '../tools/FileReadTool/limits.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { quote } from './bash/shellQuote.js'
import { toError } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'
import { ensureToolResultsDir, getToolResultsDir } from './toolResultStorage.js'

/**
 * Generates a format description string based on the MCP result type and schema.
 */
export function getFormatDescription(
  type: MCPResultType,
  schema?: unknown,
): string {
  switch (type) {
    case 'toolResult':
      return 'Plain text'
    case 'structuredContent':
      return schema ? `JSON with schema: ${schema}` : 'JSON'
    case 'contentArray':
      return schema ? `JSON array with schema: ${schema}` : 'JSON array'
  }
}

/**
 * Generates instruction text for Claude to read from a saved output file.
 *
 * @param rawOutputPath - Path to the saved output file
 * @param contentLength - Length of the content in characters
 * @param formatDescription - Description of the content format
 * @param maxReadLength - Optional max chars for Read tool (for Bash output context)
 * @param lines - Line count and longest line of a plain-text file; omit for JSON
 * @returns Instruction text to include in the tool result
 */
export function getLargeOutputInstructions(
  rawOutputPath: string,
  contentLength: number,
  formatDescription: string,
  maxReadLength?: number,
  lines?: { count: number; maxLen: number },
): string {
  const size = lines
    ? `${contentLength.toLocaleString()} characters across ${lines.count.toLocaleString()} ${lines.count === 1 ? 'line' : 'lines'}`
    : `${contentLength.toLocaleString()} characters`
  // Read pages by line, so it can only chunk a file whose lines fit one read.
  const maxLineLength = Math.floor(
    getDefaultFileReadingLimits().maxTokens * 4 * 0.8,
  )
  let howToRead: string
  let lineNote: string
  if (!lines) {
    howToRead = `Use jq to make structured queries (find a value, filter by field).\n`
    lineNote = `- Note: this file is JSON, so a long value (or the whole file) is a single line. ${FILE_READ_TOOL_NAME}'s offset/limit cannot split a line, so reading in chunks works only if every line is short. If a shell tool is available, first probe the structure (e.g., jq 'type, length, keys?' ${quote([rawOutputPath])}), then extract slices with jq or python.\n`
  } else if (lines.count === 1 || lines.maxLen > maxLineLength) {
    howToRead = `Search within the file for specific content, and use jq if the content is JSON.\n`
    lineNote = `- Note: this file's lines are too long for ${FILE_READ_TOOL_NAME}'s offset/limit chunking. If a shell tool is available, slice by character range (e.g. python read()[A:B], dd, or cut -c) instead.\n`
  } else {
    howToRead = `Use offset and limit parameters to read specific portions of the file, search within it for specific content, and jq to make structured queries.\n`
    lineNote = ''
  }

  const baseInstructions =
    `Error: result (${size}) exceeds maximum allowed tokens. Output has been saved to ${rawOutputPath}.\n` +
    `Format: ${formatDescription}\n` +
    howToRead +
    `REQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:\n` +
    `- You MUST read the content from the file at ${rawOutputPath} in sequential chunks until 100% of the content has been read.\n` +
    lineNote

  const truncationWarning = maxReadLength
    ? `- If you receive truncation warnings when reading the file ("[N lines truncated]"), reduce the chunk size until you have read 100% of the content without truncation ***DO NOT PROCEED UNTIL YOU HAVE DONE THIS***. Bash output is limited to ${maxReadLength.toLocaleString()} chars.\n`
    : `- If you receive truncation warnings when reading the file, reduce the chunk size until you have read 100% of the content without truncation.\n`

  const completionRequirement =
    `- Before producing ANY summary or analysis, you MUST explicitly describe what portion of the content you have read. ***If you did not read the entire content, you MUST explicitly state this.***\n` +
    `- If after a few attempts you cannot read the file (file not found, lines too long for ${FILE_READ_TOOL_NAME}'s offset/limit, no shell access), STOP retrying. Summarize what you were able to read, explicitly state which portion you could not read and why, and proceed.\n`

  return baseInstructions + truncationWarning + completionRequirement
}

/**
 * Map a mime type to a file extension. Conservative: known types get their
 * proper extension; unknown types get 'bin'. The extension matters because
 * the Read tool dispatches on it (PDFs, images, etc. need the right ext).
 */
export function extensionForMimeType(mimeType: string | undefined): string {
  if (!mimeType) return 'bin'
  // Strip any charset/boundary parameter
  const mt = (mimeType.split(';')[0] ?? '').trim().toLowerCase()
  switch (mt) {
    case 'application/pdf':
      return 'pdf'
    case 'application/json':
      return 'json'
    case 'text/csv':
      return 'csv'
    case 'text/plain':
      return 'txt'
    case 'text/html':
      return 'html'
    case 'text/markdown':
      return 'md'
    case 'application/zip':
      return 'zip'
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx'
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx'
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return 'pptx'
    case 'application/msword':
      return 'doc'
    case 'application/vnd.ms-excel':
      return 'xls'
    case 'audio/mpeg':
      return 'mp3'
    case 'audio/wav':
      return 'wav'
    case 'audio/ogg':
      return 'ogg'
    case 'video/mp4':
      return 'mp4'
    case 'video/webm':
      return 'webm'
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/svg+xml':
      return 'svg'
    default:
      return 'bin'
  }
}

/**
 * Heuristic for whether a content-type header indicates binary content that
 * should be saved to disk rather than put into the model context.
 * Text-ish types (text/*, json, xml, form data) are treated as non-binary.
 */
export function isBinaryContentType(contentType: string): boolean {
  if (!contentType) return false
  const mt = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (mt.startsWith('text/')) return false
  // Structured text formats delivered with an application/ type. Use suffix
  // or exact match rather than substring so 'openxmlformats' (docx/xlsx) stays binary.
  if (mt.endsWith('+json') || mt === 'application/json') return false
  if (mt.endsWith('+xml') || mt === 'application/xml') return false
  if (mt.startsWith('application/javascript')) return false
  if (mt === 'application/x-www-form-urlencoded') return false
  return true
}

export type PersistBinaryResult =
  | { filepath: string; size: number; ext: string }
  | { error: string }

/**
 * Write raw binary bytes to the tool-results directory with a mime-derived
 * extension. Unlike persistToolResult (which stringifies), this writes the
 * bytes as-is so the resulting file can be opened with native tools (Read
 * for PDFs, pandas for xlsx, etc.).
 */
export async function persistBinaryContent(
  bytes: Buffer,
  mimeType: string | undefined,
  persistId: string,
): Promise<PersistBinaryResult> {
  await ensureToolResultsDir()
  const ext = extensionForMimeType(mimeType)
  const filepath = join(getToolResultsDir(), `${persistId}.${ext}`)

  try {
    await writeFile(filepath, bytes)
  } catch (error) {
    const err = toError(error)
    logError(err)
    return { error: err.message }
  }

  // mime type and extension are safe fixed-vocabulary strings (not paths/code)
  logEvent('tengu_binary_content_persisted', {
    mimeType: (mimeType ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    sizeBytes: bytes.length,
    ext: ext as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return { filepath, size: bytes.length, ext }
}

/**
 * Build a short message telling Claude where binary content was saved.
 * Just states the path — no prescriptive hint, since what the model can
 * actually do with the file depends on provider/tooling.
 */
export function getBinaryBlobSavedMessage(
  filepath: string,
  mimeType: string | undefined,
  size: number,
  sourceDescription: string,
): string {
  const mt = mimeType || 'unknown type'
  return `${sourceDescription}Binary content (${mt}, ${formatFileSize(size)}) saved to ${filepath}`
}
