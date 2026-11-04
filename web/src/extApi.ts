// Client for /api/ext (src/web/extensions.ts): the sidebar dialogs' data.

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/ext/${path}`, {
    method,
    ...(body !== undefined && {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  if (!res.ok) {
    let message = res.statusText
    try {
      message = ((await res.json()) as { error?: string }).error ?? message
    } catch {
      // Not JSON.
    }
    throw new Error(message)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

export type Skill = {
  name: string
  display: string
  group: 'project' | 'user' | 'plugin' | 'builtin'
  where: string
  description: string
  on: boolean
  toggleable: boolean
}

export type InstalledPlugin = {
  id: string
  name: string
  marketplace: string
  version: string
  description: string
  on: boolean
  parts: Record<string, number>
  update?: string
}

export type MarketPlugin = {
  id: string
  name: string
  marketplace: string
  description: string
  installed: boolean
  channel: boolean
}

export type Marketplace = { name: string; url: string; official: boolean }

export type ChannelPlugin = {
  name: string
  displayName: string
  plugin: string
  server: string
  pluginEnabled: boolean
  def: boolean
}

export type MemoryFile = {
  id: string
  kind: 'user' | 'project' | 'local' | 'other' | 'auto'
  title: string
  where: string
  modified?: number
  body: string
  /** A user or project CLAUDE.md that does not exist yet. */
  missing?: boolean
}

/** A search snippet; `match` is where its bracketed match sits, brackets included. */
export type MemorySnippet = { snippet: string; match?: [number, number] }

export type MemoryList = {
  files: MemoryFile[]
  autoMemory: boolean
  sqlite: boolean
  index?: { path: string; files: number; chunks: number; builtAt?: number }
}

export type HookRow = {
  id?: string
  event: string
  matcher: string
  command: string
  timeout?: number
  source: 'user' | 'project' | 'local' | 'policy' | 'plugin'
  label: string
}

export type HookInput = {
  event: string
  matcher: string
  command: string
  timeout?: number
  source: 'user' | 'project'
}

export type Mod = {
  id: string
  plugin: string
  on: boolean
  description: string
  file: string
  editable: boolean
  events: string[]
  surfaces: string[]
}

export type Stats = {
  days: { date: string; sessions: number; messages: number }[]
  tokens: { date: string; byModel: Record<string, number> }[]
  streaks: { current: number; longest: number }
  longestSessionMs: number
  hours: number[]
  totalSessions: number
  /** The ChatGPT account's Codex activity (`wham/profiles/me`); null when not signed in with ChatGPT. */
  codex?: {
    lifetimeTokens: number | null
    peakDailyTokens: number | null
    currentStreakDays: number | null
    longestStreakDays: number | null
    longestTurnSec: number | null
    daily: { date: string; tokens: number }[]
  } | null
}

const enc = encodeURIComponent

export const ext = {
  skills: () => call<Skill[]>('GET', 'skills'),
  skillContent: (name: string) => call<{ content: string; file?: string }>('GET', `skills/${enc(name)}`),
  setSkill: (name: string, on: boolean) => call<void>('PUT', `skills/${enc(name)}`, { on }),
  plugins: () =>
    call<{ installed: InstalledPlugin[]; discover: MarketPlugin[]; marketplaces: Marketplace[] }>('GET', 'plugins'),
  plugin: (id: string, action: 'install' | 'uninstall' | 'enable' | 'disable' | 'update') =>
    call<{ message: string }>('POST', 'plugins', { id, action }),
  addMarketplace: (source: string) => call<{ name: string }>('POST', 'marketplaces', { source }),
  marketplace: (name: string, action: 'refresh' | 'remove') => call<void>('POST', 'marketplaces', { name, action }),
  channels: () => call<ChannelPlugin[]>('GET', 'channels'),
  setDefaultChannel: (plugin: string, on: boolean) => call<void>('PUT', 'channels', { plugin, on }),
  memory: () => call<MemoryList>('GET', 'memory'),
  searchMemory: (q: string, scope: string) =>
    call<{ memory: (MemorySnippet & { id: string })[]; sessions: (MemorySnippet & { session: string })[] }>(
      'GET',
      `memory/search?q=${enc(q)}&scope=${enc(scope)}`,
    ),
  setMemory: (key: 'autoMemory' | 'sqlite', on: boolean) => call<void>('PUT', 'memory', { key, on }),
  hooks: () => call<{ disabled: boolean; hooks: HookRow[] }>('GET', 'hooks'),
  addHook: (hook: HookInput) => call<void>('POST', 'hooks', hook),
  updateHook: (id: string, hook: HookInput) => call<void>('PUT', 'hooks', { id, ...hook }),
  deleteHook: (id: string) => call<void>('DELETE', 'hooks', { id }),
  setHooksDisabled: (on: boolean) => call<void>('PUT', 'hooks/disabled', { on }),
  mods: () => call<Mod[]>('GET', 'mods'),
  setMod: (id: string, on: boolean) => call<{ message: string }>('PUT', `mods/${enc(id)}`, { on }),
  modSource: (id: string) => call<{ source: string }>('GET', `mods/${enc(id)}/source`),
  saveModSource: (id: string, source: string) => call<void>('PUT', `mods/${enc(id)}/source`, { source }),
  stats: () => call<Stats>('GET', 'stats'),
}
