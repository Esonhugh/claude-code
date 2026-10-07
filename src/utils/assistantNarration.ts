import { logForDebugging } from './debug.js'

type Thinking = { type: string; thinking?: unknown; signature?: unknown }
const kinds = new WeakMap<object, string | undefined>()
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
let reported = false

function varint(bytes: Uint8Array, start: number): { value: number; next: number } | undefined {
  let value = 0, scale = 1
  for (let index = 0; index < 10; index++) {
    const byte = bytes[start + index]
    if (byte === undefined) return undefined
    value += (byte & 127) * scale
    if (!(byte & 128)) return { value, next: start + index + 1 }
    scale *= 128
  }
  return undefined
}

// Match the native protobuf projection: the last byte field wins only if the whole buffer is valid.
function byteField(bytes: Uint8Array, wanted: number): Uint8Array | undefined {
  let offset = 0, found: Uint8Array | undefined
  while (offset < bytes.length) {
    const key = varint(bytes, offset)
    if (!key) return undefined
    offset = key.next
    switch (key.value & 7) {
      case 0: {
        const value = varint(bytes, offset)
        if (!value) return undefined
        offset = value.next
        break
      }
      case 1: offset += 8; if (offset > bytes.length) return undefined; break
      case 2: {
        const length = varint(bytes, offset)
        if (!length || length.value > bytes.length - length.next) return undefined
        offset = length.next + length.value
        if (Math.floor(key.value / 8) === wanted) found = bytes.subarray(length.next, offset)
        break
      }
      case 5: offset += 4; if (offset > bytes.length) return undefined; break
      default: return undefined
    }
  }
  return found
}

function signatureKind(signature: string): string | undefined {
  let binary: string
  try { binary = atob(signature) } catch { return undefined }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const envelope = byteField(bytes, 2)
  const metadata = envelope && byteField(envelope, 1)
  const kind = metadata && byteField(metadata, 8)
  return kind === undefined ? undefined : decoder.decode(kind)
}

/** Display classification only; this does not authenticate or forge a thinking signature. */
export function isAssistantNarrationSummary(block: Thinking): boolean {
  try {
    if (block.type !== 'thinking' || typeof block.thinking !== 'string' || !block.thinking.trim() ||
        typeof block.signature !== 'string' || !block.signature) return false
    if (!kinds.has(block)) kinds.set(block, signatureKind(block.signature))
    return kinds.get(block) === 'narration'
  } catch (error) {
    if (!reported) {
      reported = true
      logForDebugging(`[AssistantSummary] narration classification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return false
  }
}
