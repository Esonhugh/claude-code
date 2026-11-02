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

export const getInfo = () => getJson<{ workspace: string }>('/api/info')

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
