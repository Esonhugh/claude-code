import type {
  Base64ImageSource,
  ImageBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

/**
 * Images and PDFs from inner calls ride on the REPL result as content blocks
 * (official 2.1.325 `Bu`, `Uu` and the REPL's mapToolResultToToolResultBlockParam);
 * the script sees a placeholder in place of their base64 (official `hn`).
 */

/** Official `go`, `wo` and `fo`. */
export const REPL_RESULT_MAX_IMAGES = 8
export const REPL_RESULT_MAX_DOCUMENTS = 4
export const REPL_BLOCK_RESULT_TEXT_CHARS = 100_000

/** Official `Yl`. */
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export type ReplImage = { base64: string; mediaType: string }
export type ReplDocument = { base64: string }
export type ReplResultBlocks = {
  images?: ReplImage[]
  imagesOmitted?: number
  documents?: ReplDocument[]
  documentsOmitted?: number
}

/** What `collectResultBlocks` reads from a call: official progress `phase`, `toolName`, `mcpContent` and `result`. */
export type BlockSourceCall = {
  toolName: string
  phase: string
  mcpContent?: boolean
  value?: unknown
}

type Kind = 'image' | 'document'

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Official `mr`. */
export function movedBytesText(base64: string, kind: Kind): string {
  return `[${base64.length} base64 chars — ${kind} bytes moved to the REPL result, subject to its per-result ${kind} cap]`
}

/** Official `Dn`: an MCP image block the REPL result can carry. */
function isMcpImage(block: unknown): block is ImageBlockParam & { source: Base64ImageSource } {
  if (!record(block) || block.type !== 'image' || !record(block.source)) return false
  const source = block.source
  return (
    source.type === 'base64' &&
    typeof source.media_type === 'string' &&
    IMAGE_MEDIA_TYPES.has(source.media_type) &&
    typeof source.data === 'string' &&
    source.data.length > 0
  )
}

/** Official `$n`: a page of a paged Read rendered as an image. */
function isPageImage(page: unknown): page is ReplImage {
  return record(page) && typeof page.base64 === 'string' && page.base64.length > 0 && typeof page.mediaType === 'string'
}

function fileBase64(value: Record<string, unknown>): string | undefined {
  const file = value.file
  return record(file) && typeof file.base64 === 'string' && file.base64.length > 0 ? file.base64 : undefined
}

/** Official `hn`: the value a script (and the stop report) sees for a call's result. */
export function scriptValue(call: { toolName: string; mcpContent?: boolean }, value: unknown): unknown {
  if (call.mcpContent === true)
    return Array.isArray(value) && value.some(isMcpImage)
      ? value.map(block =>
          isMcpImage(block) ? { ...block, source: { ...block.source, data: movedBytesText(block.source.data, 'image') } } : block,
        )
      : value
  if (call.toolName !== FILE_READ_TOOL_NAME || !record(value) || !('type' in value)) return value
  const base64 = fileBase64(value)
  if ((value.type === 'image' || value.type === 'pdf') && base64 !== undefined) {
    const file = value.file as Record<string, unknown>
    if (value.type === 'image' && typeof file.type !== 'string') return value
    return { ...value, file: { ...file, base64: movedBytesText(base64, value.type === 'pdf' ? 'document' : 'image') } }
  }
  if (value.type === 'parts' && Array.isArray(value.pages) && value.pages.some(isPageImage))
    return {
      ...value,
      pages: value.pages.map(page => (isPageImage(page) ? { ...page, base64: movedBytesText(page.base64, 'image') } : page)),
    }
  return value
}

/** Official `Bu` (without the shown-often refusal) and `Uu`: what the finished calls hand the REPL result. */
export function collectResultBlocks(calls: readonly BlockSourceCall[]): ReplResultBlocks {
  const images: ReplImage[] = []
  const documents: ReplDocument[] = []
  for (const call of calls) {
    if (call.phase !== 'complete') continue
    const value = call.value
    if (call.mcpContent === true) {
      if (Array.isArray(value))
        for (const block of value) if (isMcpImage(block)) images.push({ base64: block.source.data, mediaType: block.source.media_type })
      continue
    }
    if (call.toolName !== FILE_READ_TOOL_NAME || !record(value)) continue
    const base64 = fileBase64(value)
    const file = value.file as Record<string, unknown> | undefined
    if (value.type === 'image' && base64 !== undefined && typeof file?.type === 'string')
      images.push({ base64, mediaType: file.type })
    else if (value.type === 'parts' && Array.isArray(value.pages)) {
      for (const page of value.pages) if (isPageImage(page)) images.push({ base64: page.base64, mediaType: page.mediaType })
    } else if (value.type === 'pdf' && base64 !== undefined) documents.push({ base64 })
  }
  const imagesOmitted = Math.max(0, images.length - REPL_RESULT_MAX_IMAGES)
  const documentsOmitted = Math.max(0, documents.length - REPL_RESULT_MAX_DOCUMENTS)
  return {
    ...(images.length > 0 && { images: images.slice(0, REPL_RESULT_MAX_IMAGES) }),
    ...(imagesOmitted > 0 && { imagesOmitted }),
    ...(documents.length > 0 && { documents: documents.slice(0, REPL_RESULT_MAX_DOCUMENTS) }),
    ...(documentsOmitted > 0 && { documentsOmitted }),
  }
}

/**
 * The REPL tool_result content when it carries blocks (official mapToolResultToToolResultBlockParam):
 * the text first, capped, then the images, the images note, the documents and the documents note.
 * Undefined when there is nothing to carry, so the result stays a string.
 */
export function resultBlockContent(
  text: string,
  blocks: ReplResultBlocks,
): Exclude<ToolResultBlockParam['content'], string | undefined> | undefined {
  if (!blocks.images?.length && !blocks.documents?.length) return undefined
  const cap = REPL_BLOCK_RESULT_TEXT_CHARS
  const shown =
    text.length > cap
      ? `${text.slice(0, cap)}\n[… ${text.length - cap} more chars truncated — block-bearing REPL results are capped at ${cap} chars of text]`
      : text || '(no text output)'
  return [
    { type: 'text', text: shown },
    ...(blocks.images ?? []).map(image => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: image.mediaType as Base64ImageSource['media_type'], data: image.base64 },
    })),
    ...(blocks.imagesOmitted
      ? [{
          type: 'text' as const,
          text: `[${blocks.imagesOmitted} more image(s) from inner tool calls not shown — a REPL result carries at most ${REPL_RESULT_MAX_IMAGES} images; fetch fewer images or PDF pages per REPL call]`,
        }]
      : []),
    ...(blocks.documents ?? []).map(document => ({
      type: 'document' as const,
      source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: document.base64 },
    })),
    ...(blocks.documentsOmitted
      ? [{
          type: 'text' as const,
          text: `[${blocks.documentsOmitted} more PDF document(s) from inner Read calls not shown — a REPL result surfaces at most ${REPL_RESULT_MAX_DOCUMENTS} documents; read fewer PDFs per call]`,
        }]
      : []),
  ]
}
