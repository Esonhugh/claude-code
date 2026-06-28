const BILLING_PREFIX = 'x-anthropic-billing-header:'
const PLACEHOLDER = 'cch=00000'

const MASK = (1n << 64n) - 1n
const SEED = 0x4d659218e32a3268n
const P1 = 0x9e3779b185ebca87n
const P2 = 0xc2b2ae3d27d4eb4fn
const P3 = 0x165667b19e3779f9n
const P4 = 0x85ebca77c2b2ae63n
const P5 = 0x27d4eb2f165667c5n

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const EMPTY = new Uint8Array()

function u64(value: bigint): bigint {
  return value & MASK
}

function rol(value: bigint, bits: bigint): bigint {
  return u64((value << bits) | (value >> (64n - bits)))
}

function readU32LE(input: Uint8Array, offset: number): bigint {
  return (
    BigInt(input[offset]!) |
    (BigInt(input[offset + 1]!) << 8n) |
    (BigInt(input[offset + 2]!) << 16n) |
    (BigInt(input[offset + 3]!) << 24n)
  )
}

function readU64LE(input: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let i = 0; i < 8; i++) {
    value |= BigInt(input[offset + i]!) << (BigInt(i) * 8n)
  }
  return value
}

function round64(acc: bigint, lane: bigint): bigint {
  return u64(rol(u64(acc + u64(lane * P2)), 31n) * P1)
}

function mergeRound(acc: bigint, value: bigint): bigint {
  return u64(u64(acc ^ round64(0n, value)) * P1 + P4)
}

function avalanche(value: bigint): bigint {
  let h = value
  h ^= h >> 33n
  h = u64(h * P2)
  h ^= h >> 29n
  h = u64(h * P3)
  h ^= h >> 32n
  return u64(h)
}

function xxh64(input: Uint8Array): bigint {
  const len = input.length
  let p = 0
  let h: bigint

  if (len >= 32) {
    let v1 = u64(SEED + P1 + P2)
    let v2 = u64(SEED + P2)
    let v3 = SEED
    let v4 = u64(SEED - P1)
    const limit = len - 32

    while (p <= limit) {
      v1 = round64(v1, readU64LE(input, p))
      p += 8
      v2 = round64(v2, readU64LE(input, p))
      p += 8
      v3 = round64(v3, readU64LE(input, p))
      p += 8
      v4 = round64(v4, readU64LE(input, p))
      p += 8
    }

    h = u64(rol(v1, 1n) + rol(v2, 7n) + rol(v3, 12n) + rol(v4, 18n))
    h = mergeRound(h, v1)
    h = mergeRound(h, v2)
    h = mergeRound(h, v3)
    h = mergeRound(h, v4)
  } else {
    h = u64(SEED + P5)
  }

  h = u64(h + BigInt(len))

  while (p + 8 <= len) {
    const k1 = round64(0n, readU64LE(input, p))
    p += 8
    h ^= k1
    h = u64(rol(h, 27n) * P1 + P4)
  }

  if (p + 4 <= len) {
    h ^= u64(readU32LE(input, p) * P1)
    p += 4
    h = u64(rol(h, 23n) * P2 + P3)
  }

  while (p < len) {
    h ^= u64(BigInt(input[p]!) * P5)
    p += 1
    h = u64(rol(h, 11n) * P1)
  }

  return avalanche(h)
}

function startsWith(
  input: Uint8Array,
  offset: number,
  pattern: Uint8Array,
): boolean {
  if (offset + pattern.length > input.length) return false
  for (let i = 0; i < pattern.length; i++) {
    if (input[offset + i] !== pattern[i]) return false
  }
  return true
}

function jsonStringEnd(input: Uint8Array, offset: number): number | null {
  let i = offset
  while (i < input.length) {
    if (input[i] === 0x5c) {
      i += 2
      continue
    }
    if (input[i] === 0x22) return i
    i += 1
  }
  return null
}

function jsonArrayEnd(input: Uint8Array, offset: number): number | null {
  let depth = 0
  let i = offset

  while (i < input.length) {
    if (input[i] === 0x22) {
      const end = jsonStringEnd(input, i + 1)
      if (end === null) return null
      i = end + 1
      continue
    }
    if (input[i] === 0x5b) depth += 1
    else if (input[i] === 0x5d) {
      depth -= 1
      if (depth === 0) return i
      if (depth < 0) return null
    }
    i += 1
  }
  return null
}

function digitsEnd(input: Uint8Array, offset: number): number {
  let i = offset
  while (i < input.length && input[i]! >= 0x30 && input[i]! <= 0x39) {
    i += 1
  }
  return i
}

function skipField(
  input: Uint8Array,
  start: number,
  end: number,
): { next: number; trimPreviousComma: boolean } {
  if (input[end] === 0x2c) return { next: end + 1, trimPreviousComma: false }
  return { next: end, trimPreviousComma: start > 0 && input[start - 1] === 0x2c }
}

const MODEL = encoder.encode('"model":"')
const MODEL_EMPTY = encoder.encode('"model":""')
const MAX_TOKENS = encoder.encode('"max_tokens":')
const FALLBACKS = encoder.encode('"fallbacks":[')
const FALLBACK_TOKEN = encoder.encode('"fallback_credit_token":"')

function filterEdit(
  input: Uint8Array,
  offset: number,
): { next: number; replacement: Uint8Array; trimPreviousComma: boolean } | null {
  if (startsWith(input, offset, MODEL)) {
    const end = jsonStringEnd(input, offset + MODEL.length)
    if (end === null) return null
    return { next: end + 1, replacement: MODEL_EMPTY, trimPreviousComma: false }
  }

  if (startsWith(input, offset, MAX_TOKENS)) {
    const start = offset + MAX_TOKENS.length
    const end = digitsEnd(input, start)
    return end > start ? { ...skipField(input, offset, end), replacement: EMPTY } : null
  }

  if (startsWith(input, offset, FALLBACKS)) {
    const end = jsonArrayEnd(input, offset + FALLBACKS.length - 1)
    return end === null
      ? null
      : { ...skipField(input, offset, end + 1), replacement: EMPTY }
  }

  if (startsWith(input, offset, FALLBACK_TOKEN)) {
    const end = jsonStringEnd(input, offset + FALLBACK_TOKEN.length)
    return end === null
      ? null
      : { ...skipField(input, offset, end + 1), replacement: EMPTY }
  }

  return null
}

function filteredPreimage(body: string): Uint8Array {
  const input = encoder.encode(body)
  const out: number[] = []
  let i = 0

  while (i < input.length) {
    const edit = filterEdit(input, i)
    if (edit) {
      if (edit.trimPreviousComma && out[out.length - 1] === 0x2c) out.pop()
      out.push(...edit.replacement)
      i = edit.next
    } else {
      out.push(input[i]!)
      i += 1
    }
  }

  return new Uint8Array(out)
}

export function computeCch(body: string): string {
  return (xxh64(filteredPreimage(body)) & 0xfffffn).toString(16).padStart(5, '0')
}

export function patchCchInRequestBody(body: string): string {
  const billingStart = body.indexOf(BILLING_PREFIX)
  if (billingStart === -1) return body

  const placeholderIndex = body.indexOf(PLACEHOLDER, billingStart)
  if (placeholderIndex === -1) return body

  const cch = computeCch(body)
  return `${body.slice(0, placeholderIndex + 4)}${cch}${body.slice(placeholderIndex + 9)}`
}

export function decodeRequestBody(body: BodyInit): string | null {
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return decoder.decode(body)
  if (body instanceof ArrayBuffer) return decoder.decode(new Uint8Array(body))
  return null
}
