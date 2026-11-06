import { type ModelOption, parseModels } from './protocol'

export type CreatedSession = { session_id: string; work_dir: string }

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error ?? res.statusText
  } catch {
    return res.statusText
  }
}

/** A failed request, with the status the server answered. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** The folder needs the trust confirmation the TUI asks for before a session may start there. */
export class NeedsTrustError extends Error {
  constructor(readonly directory: string) {
    super(`Not trusted yet: ${directory}`)
  }
}

export async function createSession(body: {
  cwd?: string
  resume?: string
  permission_mode?: string
  model?: string
  temporary?: boolean
  /** The user accepted the trust confirmation for `cwd`. */
  trust?: boolean
}): Promise<CreatedSession> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 409) {
    const answer = (await res.clone().json().catch(() => ({}))) as { needs_trust?: unknown }
    if (typeof answer.needs_trust === 'string') throw new NeedsTrustError(answer.needs_trust)
  }
  if (!res.ok) throw new Error(await errorText(res))
  return (await res.json()) as CreatedSession
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new ApiError(await errorText(res), res.status)
  return (await res.json()) as T
}

/** A session row of `GET /api/sidebar` (src/web/sidebar.ts). */
export type HistoryItem = {
  id: string
  title: string
  /** Where `title` came from: a title, the last message, or neither (the session id). */
  label?: 'title' | 'message' | 'id'
  cwd?: string
  lastModified: number
  pinnedAt?: number
  unread?: boolean
  archived?: boolean
  projectId?: string
  /** Files the session wrote, when known. */
  files?: number
}

export type SidebarData = {
  sessions: HistoryItem[]
  folders: Record<string, number>
  more: boolean
}

/** `GET /api/peers`: live Claude sessions with a messaging socket in a folder, as ListAgents sees them. */
export type Peer = { name: string; ref: string; session_id: string; pid: number; kind: string | null; status: string | null; address: string }

export const getPeers = (cwd: string) =>
  getJson<{ peers: Peer[] }>(`/api/peers?cwd=${encodeURIComponent(cwd)}`).then(r => r.peers)

export const loadSidebar = (limit: number) => getJson<SidebarData>(`/api/sidebar?limit=${limit}`)

/** Where a box's prompts go in the CLI's ↑ history: the folder, and the session when there is one. */
export type HistoryScope = { cwd: string; sessionId?: string }

/** The folder's ↑ history, newest first: what was typed here and in the CLI. */
export const loadPromptHistory = (cwd: string) =>
  getJson<{ prompts: string[] }>(`/api/prompt-history?cwd=${encodeURIComponent(cwd)}`).then(r => r.prompts)

export const recordPrompt = (scope: HistoryScope, text: string) =>
  sendJson('/api/prompt-history', 'POST', { cwd: scope.cwd, session_id: scope.sessionId, text })

export type SessionMetaPatch = {
  title?: string | null
  pinned?: boolean
  unread?: boolean
  archived?: boolean
  project_id?: string | null
}

export const patchSessionMeta = (id: string, patch: SessionMetaPatch) =>
  sendJson(`/api/sessions/${encodeURIComponent(id)}/meta`, 'PATCH', patch)

/** Stops the session if it runs and deletes its transcript. */
export const deleteTranscript = (id: string) =>
  sendJson(`/api/sessions/${encodeURIComponent(id)}?transcript=1`, 'DELETE')

/**
 * Opens with the default app of the machine running `claude web`: the session's folder,
 * a folder inside it, or a file the session may show (`reveal`: the folder holding it).
 */
export const openLocal = (id: string, path?: string, reveal?: boolean) =>
  sendJson(`/api/sessions/${encodeURIComponent(id)}/open`, 'POST', { path, reveal })

/** Archives the project (stops its coordinator); `purge` deletes it. */
export const removeProject = (id: string, purge: boolean) =>
  sendJson(`/api/projects/${encodeURIComponent(id)}${purge ? '?purge=1' : ''}`, 'DELETE')

export type TranscriptPage = {
  messages: unknown[]
  start: number
  total: number
  cwd?: string
  title?: string
  rewindPoints?: string[]
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
  getJson<{ workspace: string; preview_origins?: string[]; temp_root?: string; home?: string; version?: string; local?: boolean }>('/api/info')

/** Files under the session's working directory matching an `@` query, relative to it. */
export const listWorkspaceFiles = (sessionId: string, query: string) =>
  getJson<{ files: string[] }>(
    `/api/files/${encodeURIComponent(sessionId)}/list?q=${encodeURIComponent(query)}`,
  ).then(r => r.files)

/** The start page's `@` search in the folder a new session would use. */
export const listFolderFiles = (cwd: string, query: string) =>
  getJson<{ files: string[] }>(`/api/folder-files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`).then(
    r => r.files,
  )

/** The models this server's sessions offer, for the pickers before any session has started. */
export const loadModels = (): Promise<ModelOption[]> =>
  getJson<{ models?: unknown }>('/api/models').then(r => parseModels(r.models))

/** The first assistant text of a transcript, for the start page's recent cards. */
export const loadSnippet = (sessionId: string) =>
  getJson<{ snippet: string }>(`/api/history/${encodeURIComponent(sessionId)}/snippet`).then(r => r.snippet)

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
  /** Providers with a saved OAuth sign-in the page can switch to without a new login. */
  oauth: AuthProvider[]
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

/** A new session with the conversation up to the reply `messageId` (`/branch`). */
export const forkSession = (id: string, messageId: string) =>
  sendJson(`/api/history/${encodeURIComponent(id)}/fork`, 'POST', { message_id: messageId }) as Promise<{ session_id: string }>

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

/** Switches to the provider's saved OAuth sign-in. */
export const useSavedOAuth = (provider: AuthProvider) =>
  sendJson('/api/account/oauth/use', 'POST', { provider }) as Promise<Account>

export const submitOAuthCode = (code: string) => sendJson('/api/account/oauth/code', 'POST', { code })

export const cancelOAuth = () => sendJson('/api/account/oauth', 'DELETE')

export const logout = () => sendJson('/api/account/logout', 'POST', {}) as Promise<Account>

export type FeatureKey = 'autoCompact' | 'gitInstructions' | 'memoryExtraction' | 'agentSummary' | 'promptSuggestions'
export type Daybreak = 'off' | 'blue' | 'red'
export type WebSettings = {
  uiName: string
  features: Record<FeatureKey, boolean>
  /** The OpenAI Daybreak access program (`/daybreak`), shown under a ChatGPT sign-in. */
  daybreak?: Daybreak
  allow_local_network: boolean
}

export const getSettings = () => getJson<WebSettings>('/api/settings')

export const patchSettings = (patch: { uiName?: string; features?: Partial<Record<FeatureKey, boolean>>; daybreak?: Daybreak }) =>
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
        /** The model id `/cost` groups by; a model reached under two ids shares it. */
        canonicalModel?: string
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

/** `/api/projects`: a folder with its own coordinator session (docs/design/claude-web-project.md). */
export type Project = {
  id: string
  name: string
  cwd: string
  instructions: string
  /** CLAUDE_CODE_SUBAGENT_MODEL for its tasks; null inherits the coordinator's model. */
  worker_model: string | null
  /** CLAUDE_CODE_SUBAGENT_EFFORT for its tasks; null inherits the coordinator's effort. */
  worker_effort?: string | null
  permission_mode: string
  coordinator_session_id: string | null
  coordinator_model?: string | null
  coordinator_effort?: string | null
  created_at: number
  updated_at: number
  running: boolean
  /** From the tasks table: all, still running (blocked included), and waiting on the user. */
  task_count?: number
  running_tasks?: number
  needs_you?: number
}

export type ProjectFields = {
  name?: string
  instructions?: string
  worker_model?: string | null
  worker_effort?: string | null
  permission_mode?: string
}

export const listProjects = () => getJson<Project[]>('/api/projects')

export async function createProject(body: ProjectFields & { name: string; cwd: string; trust?: boolean }): Promise<Project> {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 409) {
    const answer = (await res.clone().json().catch(() => ({}))) as { needs_trust?: unknown }
    if (typeof answer.needs_trust === 'string') throw new NeedsTrustError(answer.needs_trust)
  }
  if (!res.ok) throw new Error(await errorText(res))
  return (await res.json()) as Project
}

export const patchProject = (id: string, patch: ProjectFields) =>
  sendJson(`/api/projects/${encodeURIComponent(id)}`, 'PATCH', patch) as Promise<Project>

/** Starts the project's coordinator, or resumes it; a running one is reused. */
export const openCoordinator = (id: string) =>
  sendJson(`/api/projects/${encodeURIComponent(id)}/coordinator`, 'POST') as Promise<CreatedSession & { fresh?: boolean }>

/** A row of `GET /api/projects/:id/tasks` (src/web/tasks.ts). */
export type ProjectTask = {
  id: string
  session_id: string
  agent_id: string
  tool_use_id: string | null
  title: string
  brief: string
  subagent_type: string | null
  model: string | null
  effort: string | null
  worktree: string | null
  state: 'running' | 'blocked' | 'review' | 'done' | 'stopped'
  stop_reason: 'user' | 'failed' | 'exited' | 'restart' | null
  error: string | null
  summary: string | null
  tokens: number
  tool_uses: number
  duration_ms: number
  /** Time of the runs before the current one (a resumed task). */
  prior_ms?: number
  last_tool: string | null
  approval_id: string | null
  created_at: number
  started_at: number
  finished_at: number | null
  reviewed_at: number | null
}

const tasksPath = (projectId: string, taskId?: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/tasks${taskId === undefined ? '' : `/${encodeURIComponent(taskId)}`}`

export const listTasks = (projectId: string) => getJson<ProjectTask[]>(tasksPath(projectId))

/** The worker's conversation from message `after` on; `reset` when it had to start over. */
export const loadTaskTranscript = (projectId: string, taskId: string, after: number) =>
  getJson<{ messages: unknown[]; next: number; reset: boolean; tokens: number }>(
    `${tasksPath(projectId, taskId)}/transcript?after=${after}`,
  )

export const reviewTask = (projectId: string, taskId: string) =>
  sendJson(`${tasksPath(projectId, taskId)}/review`, 'POST') as Promise<ProjectTask>
