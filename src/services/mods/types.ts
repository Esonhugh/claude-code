import type { ModMatcher } from './matcher.js'

export type ModTier = 'prepend' | 'user' | 'append' | 'builtin' | 'core'
export type ModInput = Record<string, unknown>
export type ModHookStream<C = unknown, R = unknown> = AsyncGenerator<C, R> & { readonly result: Promise<R> }
export type ModTurnUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string }
export type ModTurnStepChunk =
  | { kind: 'engine'; ref: number }
  | { kind: 'text' | 'thinking'; index: number; text: string; ref?: number }
  | { kind: 'tool'; index: number; id: string; name: string; ref?: number }
  | { kind: 'input'; index: number; json: string; ref?: number }
  | { kind: 'stop'; stopReason: ModTurnStepResult['stopReason']; usage: ModTurnUsage | null; ref?: number }
export type ModTurnStepResult = {
  turnId: string
  index: number
  answer: string
  toolUses: readonly { name: string; input: unknown }[]
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'compaction' | 'refusal' | 'model_context_window_exceeded' | null
  usage: ModTurnUsage | null
}

export type ModRegistration = {
  id: number
  event: string
  matcher?: { readonly [key: string]: ModMatcher }
  hasCatch: boolean
}

export type ModModule = {
  path: string
  source: string
}

export type ModDeclaration = {
  name: string
  storageId: string
  version?: string
  /** Host-owned admission identity; never inferred from manifest metadata or tier. */
  isNative?: boolean
  pluginRoot: string
  entrypoints: string[]
  modules: ModModule[]
  links: { from: string; specifier: string; to: string }[]
  clients?: { path: string; module: string }[]
  events: string[]
  calls: string[]
  env?: { reads: string[]; writes: string[] }
  nextTiers: ModTier[]
  options: ModInput
  tier: ModTier
  fingerprint: string
}

export type ModOrigin = { plugin: string; tier: ModTier }

export type ModTraceEntry = {
  index: number
  plugin: string
  tier: ModTier
  event: string
  outcome: string
  reason?: string
  ms: number
  chunks?: number
  received: unknown
  returned: unknown
}

export type ModNext = {
  (input: ModInput): Promise<unknown>
  to(input: ModInput, tier: ModTier): Promise<unknown>
  is(event: string, input: unknown): boolean
  signal: AbortSignal
  event: string
  origin: ModOrigin
  trace: readonly ModTraceEntry[]
  budget: { readonly ms: number; readonly remainingMs: number }
  error?: { readonly kind: 'throw' | 'timeout'; readonly message?: string; readonly budget: number }
  called?: boolean
}

export type ModDispatchHook = {
  plugin: string
  tier: ModTier
  registration: ModRegistration
  invoke(input: ModInput, next: ModNext, catching: boolean): Promise<unknown>
  invokeStream?(input: ModInput, next: ModNext, catching: boolean): AsyncGenerator<unknown, unknown>
}
