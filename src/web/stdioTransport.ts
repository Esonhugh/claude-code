import { once } from 'events'
import type { ServerLogger } from '../server/serverLog.js'
import type { SessionSocket } from '../server/sessionManager.js'

/**
 * `claude web --stdio`: the server's HTTP requests and WebSockets carried as
 * JSON lines over stdin/stdout, so the desktop app talks to it without a port.
 * Each frame is one line starting with the prefix; other stdout lines are not
 * frames and the app ignores them. Bodies are base64.
 *
 *   app → server: { t: 'req', id, method, path, headers, body? }
 *                 { t: 'cancel', id }
 *                 { t: 'ws', id, path, headers }   { t: 'wsmsg', id, data }   { t: 'wsclose', id, code?, reason? }
 *   server → app: { t: 'ready' }
 *                 { t: 'res', id, status, headers }   { t: 'body', id, data }   { t: 'end', id }
 *                 { t: 'wsopen', id }   { t: 'wsmsg', id, data }   { t: 'wsclose', id, code, reason }
 */
export const STDIO_FRAME_PREFIX = '\x1eclaude-web '
/** The Host the app sends; its page's origin is `http://<STDIO_HOST>` to the server. */
export const STDIO_HOST = 'claude-desktop'
// The pipe's only peer is the app that started this process, on this machine.
const STDIO_PEER = { address: '127.0.0.1', family: 'IPv4', port: 0 }

type HeaderList = [string, string][]
type AppFrame =
  | { t: 'req'; id: number; method: string; path: string; headers: HeaderList; body?: string }
  | { t: 'cancel'; id: number }
  | { t: 'ws'; id: number; path: string; headers: HeaderList }
  | { t: 'wsmsg'; id: number; data: string }
  | { t: 'wsclose'; id: number; code?: number; reason?: string }

export type StdioServer<D> = {
  requestIP: (req: Request) => typeof STDIO_PEER
  upgrade: (req: Request, opts: { data: D }) => boolean
}

export type StdioSocket<D> = SessionSocket & { data: D }

export type StdioHandlers<D> = {
  fetch: (req: Request, srv: StdioServer<D>) => Promise<Response | undefined>
  error: (err: Error) => Response
  websocket: {
    open: (ws: StdioSocket<D>) => void
    message: (ws: StdioSocket<D>, message: string) => void
    close: (ws: StdioSocket<D>) => void
  }
}

export function serveStdio<D>(
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
  handlers: StdioHandlers<D>,
  logger: ServerLogger,
): () => void {
  const requests = new Map<number, AbortController>()
  // Each open socket and how to drop it without telling the app.
  const sockets = new Map<number, { ws: StdioSocket<D>; drop: () => void }>()
  const send = (frame: object): boolean =>
    io.output.write(STDIO_FRAME_PREFIX + JSON.stringify(frame) + '\n')

  async function request(frame: Extract<AppFrame, { t: 'req' }>): Promise<void> {
    const abort = new AbortController()
    requests.set(frame.id, abort)
    let res: Response | undefined
    try {
      const req = new Request(`http://${STDIO_HOST}${frame.path}`, {
        method: frame.method,
        headers: frame.headers,
        body: frame.body ? Buffer.from(frame.body, 'base64') : undefined,
        signal: abort.signal,
      })
      res = await handlers.fetch(req, { requestIP: () => STDIO_PEER, upgrade: () => false })
    } catch (err) {
      res = handlers.error(err as Error)
    }
    res ??= handlers.error(new Error('no response'))
    try {
      const headers: HeaderList = []
      res.headers.forEach((value, key) => headers.push([key, value]))
      send({ t: 'res', id: frame.id, status: res.status, headers })
      const reader = res.body?.getReader()
      while (reader && !abort.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        if (!send({ t: 'body', id: frame.id, data: Buffer.from(value).toString('base64') })) {
          await once(io.output, 'drain')
        }
      }
      if (abort.signal.aborted) await reader?.cancel()
    } catch (err) {
      logger.warn(`stdio response ${frame.id} failed: ${(err as Error).message}`)
    } finally {
      requests.delete(frame.id)
      send({ t: 'end', id: frame.id })
    }
  }

  async function openSocket(frame: Extract<AppFrame, { t: 'ws' }>): Promise<void> {
    let data: D | undefined
    let res: Response | undefined
    try {
      const req = new Request(`http://${STDIO_HOST}${frame.path}`, {
        headers: [...frame.headers, ['upgrade', 'websocket']],
      })
      res = await handlers.fetch(req, {
        requestIP: () => STDIO_PEER,
        upgrade: (_req, opts) => {
          data = opts.data
          return true
        },
      })
    } catch (err) {
      res = handlers.error(err as Error)
    }
    if (data === undefined) {
      // A browser sees a refused upgrade as an abnormal close before open.
      const reason = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : undefined
      send({ t: 'wsclose', id: frame.id, code: 1006, reason: reason ?? '' })
      return
    }
    let open = true
    const drop = () => {
      open = false
      sockets.delete(frame.id)
      handlers.websocket.close(ws)
    }
    const ws: StdioSocket<D> = {
      data,
      send: message => open && send({ t: 'wsmsg', id: frame.id, data: message }),
      close: (code = 1000, reason = '') => {
        if (!open) return
        send({ t: 'wsclose', id: frame.id, code, reason })
        drop()
      },
    }
    sockets.set(frame.id, { ws, drop })
    send({ t: 'wsopen', id: frame.id })
    handlers.websocket.open(ws)
  }

  function dispatch(frame: AppFrame): void {
    switch (frame.t) {
      case 'req':
        void request(frame)
        return
      case 'cancel':
        requests.get(frame.id)?.abort()
        return
      case 'ws':
        void openSocket(frame)
        return
      case 'wsmsg': {
        const socket = sockets.get(frame.id)
        if (socket) handlers.websocket.message(socket.ws, frame.data)
        return
      }
      case 'wsclose':
        // The app closed it; nothing is sent back.
        sockets.get(frame.id)?.drop()
        return
    }
  }

  let buffer = ''
  const onData = (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith(STDIO_FRAME_PREFIX)) continue
      let frame: AppFrame
      try {
        frame = JSON.parse(line.slice(STDIO_FRAME_PREFIX.length)) as AppFrame
      } catch {
        logger.warn('ignored a malformed stdio frame')
        continue
      }
      dispatch(frame)
    }
  }
  io.input.setEncoding('utf8')
  io.input.on('data', onData)
  io.input.resume()
  send({ t: 'ready' })

  return () => {
    io.input.off('data', onData)
    for (const abort of requests.values()) abort.abort()
    for (const { ws } of [...sockets.values()]) ws.close(1001, 'Server stopped')
  }
}
