export type ModTier = 'prepend' | 'user' | 'append' | 'builtin' | 'core'
export type ModInput = Record<string, unknown>

export type ModRegistration = {
  id: number
  event: string
  matcher?: ModInput
  hasCatch: boolean
}

export type ModModule = {
  path: string
  source: string
}

export type ModDeclaration = {
  name: string
  storageId: string
  pluginRoot: string
  entrypoints: string[]
  modules: ModModule[]
  links: { from: string; specifier: string; to: string }[]
  events: string[]
  calls: string[]
  nextTiers: ModTier[]
  options: ModInput
  tier: ModTier
  fingerprint: string
}

export type ModOrigin = { plugin: string; tier: ModTier }

export type ModTraceEntry = {
  plugin: string
  tier: ModTier
  outcome: string
  received: unknown
  returned?: unknown
}

export type ModNext = {
  (input: ModInput): Promise<unknown>
  to(input: ModInput, tier: ModTier): Promise<unknown>
  is(event: string, input: unknown): boolean
  signal: AbortSignal
  event: string
  origin: ModOrigin
  trace: readonly ModTraceEntry[]
  error?: { readonly kind: 'throw' | 'timeout'; readonly message?: string; readonly budget: number }
  called?: boolean
}

export type ModDispatchHook = {
  plugin: string
  tier: ModTier
  registration: ModRegistration
  invoke(input: ModInput, next: ModNext, catching: boolean): Promise<unknown>
}
