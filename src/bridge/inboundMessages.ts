import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { detectImageFormatFromBase64 } from '../utils/imageResizer.js'
import type { SessionReceiveOrigin } from '../services/mods/receiveAdapter.js'

/**
 * Process an inbound user message from the bridge, extracting content
 * and UUID for enqueueing. Supports both string content and
 * ContentBlockParam[] (e.g. messages containing images).
 *
 * Normalizes image blocks from bridge clients that may use camelCase
 * `mediaType` instead of snake_case `media_type` (mobile-apps#5825).
 *
 * Returns the extracted fields, or undefined if the message should be
 * skipped (non-user type, missing/empty content).
 */
export function extractInboundMessageFields(
  msg: SDKMessage,
):
  | { content: string | Array<ContentBlockParam>; uuid: UUID | undefined; origin: SessionReceiveOrigin }
  | undefined {
  if (msg.type !== 'user') return undefined
  // @ts-ignore - recovered code
  const content = msg.message?.content
  if (!content || (typeof content !== 'string' && !Array.isArray(content))) return undefined
  if (Array.isArray(content) && content.length === 0) return undefined

  const uuid =
    'uuid' in msg && typeof msg.uuid === 'string'
      ? (msg.uuid as UUID)
      : undefined

  const sanitized = Array.isArray(content)
    ? normalizeImageBlocks(content)
      .filter(block => block.type !== 'text' || typeof block.text === 'string')
      .map(block => block.type === 'text' ? { ...block, text: stripTransportReminders(block.text) } : block)
      .filter(block => block.type !== 'text' || block.text.trim() !== '')
    : stripTransportReminders(content)
  if (Array.isArray(sanitized) && sanitized.length === 0) return undefined
  // These fields are server stamps on the bridge transport, never text parsing.
  const platform = 'client_platform' in msg ? msg.client_platform : undefined
  const inbound = 'inbound_origin' in msg ? msg.inbound_origin : undefined
  const kind: SessionReceiveOrigin['kind'] =
    ['scheduled_trigger', 'force_run_trigger', 'fire_routine'].includes(platform as string) ? 'scheduled-trigger'
      : ['github_webhook_trigger', 'pr_steward'].includes(platform as string) || ['trigger_fire', 'plugin_fire'].includes(inbound as string) ? 'task-notification'
        : platform === undefined || ['ios', 'android', 'web_claude_ai', 'desktop_app'].includes(platform as string) ? 'bridge'
          : 'unclassified'
  return { content: sanitized, uuid, origin: { kind } }
}

function stripTransportReminders(text: string): string {
  let body = text.trimStart()
  let changed = false
  while (body.startsWith('<system-reminder>')) {
    const end = body.indexOf('</system-reminder>')
    if (end < 0) break
    body = body.slice(end + '</system-reminder>'.length).trimStart()
    changed = true
  }
  body = (changed ? body : text).trimEnd()
  while (body.endsWith('</system-reminder>')) {
    const start = body.lastIndexOf('<system-reminder>')
    if (start < 0 || (start > 0 && body[start - 1] !== '\n')) break
    body = body.slice(0, start).trimEnd()
    changed = true
  }
  return changed && body !== '' ? body : text
}

/**
 * Normalize image content blocks from bridge clients. iOS/web clients may
 * send `mediaType` (camelCase) instead of `media_type` (snake_case), or
 * omit the field entirely. Without normalization, the bad block poisons
 * the session — every subsequent API call fails with
 * "media_type: Field required".
 *
 * Fast-path scan returns the original array reference when no
 * normalization is needed (zero allocation on the happy path).
 */
export function normalizeImageBlocks(
  blocks: Array<ContentBlockParam>,
): Array<ContentBlockParam> {
  if (!blocks.some(isMalformedBase64Image)) return blocks

  return blocks.map(block => {
    if (!isMalformedBase64Image(block)) return block
    const src = block.source as unknown as Record<string, unknown>
    const mediaType =
      typeof src.mediaType === 'string' && src.mediaType
        ? src.mediaType
        : detectImageFormatFromBase64(block.source.data)
    return {
      ...block,
      source: {
        type: 'base64' as const,
        media_type: mediaType as Base64ImageSource['media_type'],
        data: block.source.data,
      },
    }
  })
}

function isMalformedBase64Image(
  block: ContentBlockParam,
): block is ImageBlockParam & { source: Base64ImageSource } {
  if (block.type !== 'image' || block.source?.type !== 'base64') return false
  return !(block.source as unknown as Record<string, unknown>).media_type
}
