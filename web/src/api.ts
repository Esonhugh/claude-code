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
  permission_mode?: string
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
      () => reject(new Error('WebSocket closed before it opened')),
      { once: true },
    )
  })
}
