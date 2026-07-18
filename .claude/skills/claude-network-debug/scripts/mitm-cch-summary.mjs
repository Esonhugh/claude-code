#!/usr/bin/env bun
import { createHash } from 'node:crypto'

const MASK = (1n << 64n) - 1n
const SEED = 0x4d659218e32a3268n
const P1 = 0x9e3779b185ebca87n
const P2 = 0xc2b2ae3d27d4eb4fn
const P3 = 0x165667b19e3779f9n
const P4 = 0x85ebca77c2b2ae63n
const P5 = 0x27d4eb2f165667c5n

function rol(x, r) {
  return ((x << BigInt(r)) | (x >> BigInt(64 - r))) & MASK
}

function round64(acc, x) {
  acc = (acc + x * P2) & MASK
  acc = rol(acc, 31)
  return (acc * P1) & MASK
}

function mergeRound(acc, value) {
  acc ^= round64(0n, value)
  return (acc * P1 + P4) & MASK
}

function readU64LE(data, offset) {
  let value = 0n
  for (let i = 0; i < 8; i += 1) {
    value |= BigInt(data[offset + i]) << BigInt(i * 8)
  }
  return value
}

function readU32LE(data, offset) {
  let value = 0n
  for (let i = 0; i < 4; i += 1) {
    value |= BigInt(data[offset + i]) << BigInt(i * 8)
  }
  return value
}

function xxh64(data, seed = SEED) {
  let i = 0
  let h

  if (data.length >= 32) {
    let v1 = (seed + P1 + P2) & MASK
    let v2 = (seed + P2) & MASK
    let v3 = seed & MASK
    let v4 = (seed - P1) & MASK

    while (i <= data.length - 32) {
      v1 = round64(v1, readU64LE(data, i))
      i += 8
      v2 = round64(v2, readU64LE(data, i))
      i += 8
      v3 = round64(v3, readU64LE(data, i))
      i += 8
      v4 = round64(v4, readU64LE(data, i))
      i += 8
    }

    h = (rol(v1, 1) + rol(v2, 7) + rol(v3, 12) + rol(v4, 18)) & MASK
    h = mergeRound(h, v1)
    h = mergeRound(h, v2)
    h = mergeRound(h, v3)
    h = mergeRound(h, v4)
  } else {
    h = (seed + P5) & MASK
  }

  h = (h + BigInt(data.length)) & MASK

  while (i + 8 <= data.length) {
    const k = round64(0n, readU64LE(data, i))
    h ^= k
    h = (rol(h, 27) * P1 + P4) & MASK
    i += 8
  }

  if (i + 4 <= data.length) {
    h ^= (readU32LE(data, i) * P1) & MASK
    h = (rol(h, 23) * P2 + P3) & MASK
    i += 4
  }

  while (i < data.length) {
    h ^= (BigInt(data[i]) * P5) & MASK
    h = (rol(h, 11) * P1) & MASK
    i += 1
  }

  h ^= h >> 33n
  h = (h * P2) & MASK
  h ^= h >> 29n
  h = (h * P3) & MASK
  h ^= h >> 32n
  return h & MASK
}

function stringEnd(data, quotePos) {
  let i = quotePos + 1
  let escaped = false
  while (i < data.length) {
    const c = data[i]
    if (escaped) escaped = false
    else if (c === 0x5c) escaped = true
    else if (c === 0x22) return i
    i += 1
  }
  throw new Error('unterminated string')
}

function valueEnd(data, valueStart) {
  let i = valueStart
  while (i < data.length && [0x20, 0x09, 0x0d, 0x0a].includes(data[i])) i += 1
  if (i >= data.length) throw new Error('missing value')

  if (data[i] === 0x22) return stringEnd(data, i) + 1

  if (data[i] === 0x7b || data[i] === 0x5b) {
    const open = data[i]
    const close = open === 0x7b ? 0x7d : 0x5d
    let depth = 0
    let inString = false
    let escaped = false
    while (i < data.length) {
      const c = data[i]
      if (inString) {
        if (escaped) escaped = false
        else if (c === 0x5c) escaped = true
        else if (c === 0x22) inString = false
      } else if (c === 0x22) inString = true
      else if (c === open) depth += 1
      else if (c === close) {
        depth -= 1
        if (depth === 0) return i + 1
      }
      i += 1
    }
    throw new Error('unmatched bracket')
  }

  while (i < data.length && data[i] !== 0x2c && data[i] !== 0x7d) i += 1
  return i
}

function topLevelFields(data) {
  const fields = []
  const objStart = data.indexOf(0x7b)
  if (objStart < 0 || data.subarray(0, objStart).toString().trim()) {
    throw new Error('body must be a JSON object')
  }

  let i = objStart + 1
  while (i < data.length) {
    while (i < data.length && [0x20, 0x09, 0x0d, 0x0a, 0x2c].includes(data[i])) i += 1
    if (i >= data.length || data[i] === 0x7d) break
    if (data[i] !== 0x22) throw new Error(`expected object key at byte ${i}`)

    const keyStart = i
    const keyEnd = stringEnd(data, keyStart)
    const key = data.subarray(keyStart + 1, keyEnd).toString('utf8')

    let j = keyEnd + 1
    while (j < data.length && [0x20, 0x09, 0x0d, 0x0a].includes(data[j])) j += 1
    if (j >= data.length || data[j] !== 0x3a) throw new Error("expected ':' after key")

    const valueStart = j + 1
    const valueStop = valueEnd(data, valueStart)

    let fieldStop = valueStop
    while (fieldStop < data.length && [0x20, 0x09, 0x0d, 0x0a].includes(data[fieldStop])) fieldStop += 1
    if (fieldStop < data.length && data[fieldStop] === 0x2c) fieldStop += 1

    fields.push({ key, keyStart, valueStart, valueStop, fieldStop })
    i = fieldStop
  }
  return fields
}

function cchHashInput(body) {
  body = Buffer.from(body.toString('utf8').replace(/cch=[0-9a-fA-F]{5};/, 'cch=00000;'))
  const cuts = []
  for (const field of topLevelFields(body)) {
    if (field.key === 'model') {
      const q1 = body.indexOf(0x22, field.valueStart)
      const q2 = stringEnd(body, q1)
      cuts.push([q1 + 1, q2])
    } else if (field.key === 'max_tokens' || field.key === 'fallbacks') {
      cuts.push([field.keyStart, field.fieldStop])
    }
  }

  cuts.sort((a, b) => a[0] - b[0])
  const chunks = []
  let pos = 0
  for (const [start, stop] of cuts) {
    chunks.push(body.subarray(pos, start))
    pos = stop
  }
  chunks.push(body.subarray(pos))
  return Buffer.concat(chunks)
}

export function computeCch(body) {
  return (xxh64(cchHashInput(body), SEED) & 0xfffffn).toString(16).padStart(5, '0')
}

export function patchCchInJsonBody(body) {
  const cch = computeCch(body)
  return Buffer.from(body.toString('utf8').replace(/cch=[0-9a-fA-F]{5};/, `cch=${cch};`))
}

function currentCch(body) {
  const match = body.toString('utf8').match(/cch=([0-9a-fA-F]{5});/)
  return match ? match[1].toLowerCase() : null
}

function summarizeSystemBlock(block) {
  const text = typeof block?.text === 'string' ? block.text : ''
  return {
    text_len: text.length,
    sha256_16: createHash('sha256').update(text).digest('hex').slice(0, 16),
    ...(block?.cache_control ? { cache_control: block.cache_control } : {}),
  }
}

export function summarizeJsonBody(body) {
  const cchExisting = currentCch(body)
  const cchComputed = cchExisting ? computeCch(body) : null
  const summary = {
    body_bytes: body.length,
    sha256_16: createHash('sha256').update(body).digest('hex').slice(0, 16),
    contains_cch_placeholder: body.includes(Buffer.from('cch=00000')),
    contains_cch_param: body.includes(Buffer.from('cch=')),
    cch_values: [...body.toString('utf8').matchAll(/cch=([0-9a-f]{5})/gi)].map(match => match[1]),
    cch_existing: cchExisting,
    cch_computed: cchComputed,
    cch_match: cchExisting ? cchExisting === cchComputed : null,
  }

  try {
    const json = JSON.parse(body.toString('utf8'))
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      summary.json_keys = Object.keys(json).sort()
      summary.model = typeof json.model === 'string' ? json.model : null
      summary.messages_count = Array.isArray(json.messages) ? json.messages.length : null
      summary.tools_count = Array.isArray(json.tools) ? json.tools.length : null
      summary.tool_names = Array.isArray(json.tools)
        ? json.tools.map(tool => tool?.name).filter(name => typeof name === 'string')
        : null
      summary.output_config = json.output_config ?? null
      summary.stream = typeof json.stream === 'boolean' ? json.stream : null
      summary.system_type = Array.isArray(json.system) ? 'array' : typeof json.system
      summary.system_count = Array.isArray(json.system) ? json.system.length : null
      summary.system_blocks = Array.isArray(json.system) ? json.system.map(summarizeSystemBlock) : null
      summary.system_text_total = Array.isArray(json.system)
        ? json.system.reduce((total, block) => total + (typeof block?.text === 'string' ? block.text.length : 0), 0)
        : null
    }
  } catch (error) {
    summary.json_parse_error = error instanceof Error ? error.message : String(error)
  }

  return summary
}
