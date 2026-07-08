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

export type WorkflowScriptIdentityOpts = {
  schema?: object
  model?: string
  effort?: string
  isolation?: 'worktree' | 'remote'
  agentType?: string
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

export function createWorkflowScriptAgentChainIdentity(input: {
  previousKey: string
  prompt: string
  opts?: WorkflowScriptIdentityOpts
}): string {
  const h = createHash('sha256')
  h.update(input.previousKey)
  h.update('\0')
  h.update(input.prompt)
  h.update('\0')
  h.update(stableJson({
    schema: input.opts?.schema,
    model: input.opts?.model,
    effort: input.opts?.effort,
    isolation: input.opts?.isolation,
    agentType: input.opts?.agentType,
  }))
  return `v2:${h.digest('hex')}`
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
