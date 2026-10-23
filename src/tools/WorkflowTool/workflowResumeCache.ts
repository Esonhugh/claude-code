import { createHash } from 'node:crypto'

type WorkflowScriptAgentOpts = {
  agentType?: string
  isolation?: 'worktree'
  label?: string
  mode?: string
  model?: string
  phase?: string
  schema?: object
}

// Like official 2.1.303, only these agent() options take part in the resume key; label,
// phase and stallMs are display/runtime-only. mode is this build's own option and is keyed
// only when set, so scripts official can run keep official's keys.
const IDENTITY_OPTS = ['schema', 'model', 'effort', 'isolation', 'agentType', 'disallowedTools', 'bashCommandClamp', 'mode']

function normalizeIdentityValue(value: unknown): unknown {
  if (typeof value === 'function') return undefined
  if (Array.isArray(value)) return value.map(normalizeIdentityValue)
  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      if (key === '__proto__') continue
      normalized[key] = normalizeIdentityValue((value as Record<string, unknown>)[key])
    }
    return normalized
  }
  return value
}

function normalizeIdentityOpts(opts: Record<string, unknown> | undefined): string {
  if (!opts) return '{}'
  const picked: Record<string, unknown> = {}
  for (const key of IDENTITY_OPTS) {
    const value = key === 'mode' && opts.mode === 'default' ? undefined : opts[key]
    if (value === undefined || typeof value === 'function') continue
    picked[key] = value
  }
  return JSON.stringify(normalizeIdentityValue(picked))
}

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
  return sha256(stableJson({
    phase: input.phase,
    prompt: input.prompt,
    opts: input.opts,
  }))
}

export function createWorkflowScriptAgentIdentity(prompt: string, opts?: WorkflowScriptAgentOpts): string {
  const h = createHash('sha256')
  h.update(prompt)
  h.update(JSON.stringify({
    agentType: opts?.agentType,
    isolation: opts?.isolation,
    label: opts?.label,
    mode: opts?.mode === 'default' ? undefined : opts?.mode,
    model: opts?.model,
    phase: opts?.phase,
    schema: opts?.schema,
  }))
  return h.digest('hex').slice(0, 16)
}

// Official 2.1.303's journal key: every agent() call chains on the previous call's key in
// call order, so a run journaled by either binary resumes in the other.
export function createWorkflowScriptAgentChainIdentity(input: {
  previousKey: string
  prompt: string
  opts?: Record<string, unknown>
}): string {
  return `v2:${sha256(`${input.previousKey}\0${input.prompt}\0${normalizeIdentityOpts(input.opts)}`)}`
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
  const byIdentity = new Map<string, WorkflowResumeCacheEntry[]>()
  for (const entry of entries) {
    const matches = byIdentity.get(entry.identity) ?? []
    matches.push(entry)
    byIdentity.set(entry.identity, matches)
  }

  return {
    lookup(_index: number, identity: string): WorkflowResumeLookup {
      const matches = byIdentity.get(identity)
      const entry = matches?.shift()
      if (!entry) return { cacheHit: false }
      return { cacheHit: true, result: entry.result }
    },
  }
}
