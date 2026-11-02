export type CreatedSession = { session_id: string; work_dir: string }

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error ?? res.statusText
  } catch {
    return res.statusText
  }
}

export async function createSession(body: {
  cwd?: string
  resume?: string
  permission_mode?: string
  model?: string
  temporary?: boolean
}): Promise<CreatedSession> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorText(res))
  return (await res.json()) as CreatedSession
}

export async function deleteSession(id: string): Promise<void> {
  await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(await errorText(res))
  return (await res.json()) as T
}

export type HistoryItem = {
  id: string
  title: string
  cwd?: string
  lastModified: number
}

export const listHistory = (offset: number, limit: number) =>
  getJson<HistoryItem[]>(`/api/history?offset=${offset}&limit=${limit}`)

export type TranscriptPage = {
  messages: unknown[]
  start: number
  total: number
  cwd?: string
  title?: string
}

export const loadTranscript = (id: string, before?: number) =>
  getJson<TranscriptPage>(
    `/api/history/${encodeURIComponent(id)}/messages?limit=200${before === undefined ? '' : `&before=${before}`}`,
  )

export const loadAgentTranscript = (sessionId: string, agentId: string) =>
  getJson<{ messages: unknown[] }>(
    `/api/history/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/messages`,
  )

/** Which subagent issued each Agent call, by tool use id. */
export const loadAgentIssuers = (sessionId: string, toolUseIds: string[]) =>
  getJson<Record<string, string>>(
    `/api/history/${encodeURIComponent(sessionId)}/agent-issuers?${toolUseIds
      .map(id => `tool_use_id=${encodeURIComponent(id)}`)
      .join('&')}`,
  )

export const listRunning = () =>
  getJson<{ id: string; work_dir: string; attached: boolean }[]>('/api/sessions')

export const getInfo = () =>
  getJson<{ workspace: string; preview_origins?: string[]; temp_root?: string }>('/api/info')

export async function renameSession(id: string, title: string): Promise<void> {
  const res = await fetch(`/api/history/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(await errorText(res))
}

/** Opens the session's stream-json socket; resolves once it is open. */
export function openSessionSocket(
  id: string,
  onMessage: (msg: unknown) => void,
): Promise<WebSocket> {
  const url = new URL(`/api/sessions/${encodeURIComponent(id)}/ws`, location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url)
  let buffer = ''
  socket.addEventListener('message', event => {
    buffer += String(event.data)
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        onMessage(JSON.parse(line))
      } catch {
        console.warn('claude web: ignored a malformed message', line)
      }
    }
  })
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(socket), { once: true })
    socket.addEventListener(
      'close',
      event =>
        reject(
          new SocketRefusedError(event.reason || 'WebSocket closed before it opened'),
        ),
      { once: true },
    )
  })
}

export class SocketRefusedError extends Error {}

export type AuthProvider = 'anthropic' | 'openai'

/** `/api/account`: of a key the page only ever gets its last four characters. */
export type Account = {
  kind: 'claude' | 'chatgpt' | 'apikey' | null
  provider: AuthProvider
  name?: string
  plan?: string
  source?: string
  /** `source` is set when the provider has a key configured. */
  keys: { provider: AuthProvider; base_url: string; source?: string; tail?: string }[]
  pending?: { provider: AuthProvider; url: string; manual_url: string }
  error?: string
}

async function sendJson(path: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(await errorText(res))
  return res.status === 200 ? res.json() : undefined
}

export const getAccount = () => getJson<Account>('/api/account')

export const saveApiKey = (provider: AuthProvider, key: string, baseUrl: string) =>
  sendJson('/api/account/api-key', 'POST', { provider, key, base_url: baseUrl }) as Promise<Account>

export const removeApiKey = (provider: AuthProvider) =>
  sendJson('/api/account/api-key', 'DELETE', { provider }) as Promise<Account>

/** Switches to the provider's saved key, keeping its base URL. */
export const useSavedKey = (provider: AuthProvider) =>
  sendJson('/api/account/api-key', 'POST', { provider }) as Promise<Account>

export const startOAuth = (provider: AuthProvider) =>
  sendJson('/api/account/oauth', 'POST', { provider }) as Promise<{ url: string; manual_url: string }>

export const submitOAuthCode = (code: string) => sendJson('/api/account/oauth/code', 'POST', { code })

export const cancelOAuth = () => sendJson('/api/account/oauth', 'DELETE')

export const logout = () => sendJson('/api/account/logout', 'POST', {}) as Promise<Account>

export type FeatureKey = 'autoCompact' | 'gitInstructions' | 'memoryExtraction' | 'agentSummary' | 'promptSuggestions'
export type WebSettings = { uiName: string; features: Record<FeatureKey, boolean>; allow_local_network: boolean }

export const getSettings = () => getJson<WebSettings>('/api/settings')

export const patchSettings = (patch: { uiName?: string; features?: Partial<Record<FeatureKey, boolean>> }) =>
  sendJson('/api/settings', 'PATCH', patch) as Promise<WebSettings>

export type UsageWindow = { utilization: number; resets_at?: string | null }

/** The `get_usage` control response (src/cli/hostControlRequests.ts); `/api/usage` answers the same shape. */
export type Usage = {
  session?: {
    total_cost_usd?: number
    total_api_duration_ms?: number
    total_duration_ms?: number
    total_lines_added?: number
    total_lines_removed?: number
    model_usage?: Record<
      string,
      {
        inputTokens?: number
        outputTokens?: number
        cacheReadInputTokens?: number
        cacheCreationInputTokens?: number
        costUSD?: number
      }
    >
  }
  subscription_type?: string | null
  rate_limits?: {
    five_hour?: UsageWindow | null
    seven_day?: UsageWindow | null
    seven_day_opus?: UsageWindow | null
    seven_day_sonnet?: UsageWindow | null
    model_scoped?: { display_name: string; utilization: number; resets_at?: string | null }[]
    extra_usage?: { is_enabled?: boolean } | null
  } | null
}

export const getUsage = () => getJson<Usage>('/api/usage')
