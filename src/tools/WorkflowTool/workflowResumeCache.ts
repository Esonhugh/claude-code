import { createHash } from 'node:crypto'

export type WorkflowResumeCacheEntry = {
  index: number
  identity: string
  phase?: string
  label?: string
  result: unknown
  completedAt: number
}

export type WorkflowResumeLookup =
  | { cacheHit: true; result: unknown }
  | { cacheHit: false }

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(',')}}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function createAgentCallIdentity(input: {
  index: number
  phase?: string
  prompt: string
  opts?: unknown
}): string {
  return sha256(stableJson(input))
}

export function recordResumeCacheEntry(input: {
  index: number
  identity: string
  phase?: string
  label?: string
  result: unknown
  completedAt?: number
}): WorkflowResumeCacheEntry {
  return {
    index: input.index,
    identity: input.identity,
    phase: input.phase,
    label: input.label,
    result: input.result,
    completedAt: input.completedAt ?? Date.now(),
  }
}

export function createWorkflowResumeCursor(entries: WorkflowResumeCacheEntry[]) {
  let prefixBroken = false
  const byIndex = new Map(entries.map(entry => [entry.index, entry]))

  return {
    lookup(index: number, identity: string): WorkflowResumeLookup {
      if (prefixBroken) return { cacheHit: false }
      const entry = byIndex.get(index)
      if (!entry || entry.identity !== identity) {
        prefixBroken = true
        return { cacheHit: false }
      }
      return { cacheHit: true, result: entry.result }
    },
  }
}
