import { mkdirSync, statSync } from 'fs'
import { isAbsolute } from 'path'
import { z } from 'zod/v4'
import { PERMISSION_MODES } from '../types/permissions.js'
import { lazySchema } from '../utils/lazySchema.js'
import type { ServerLogger } from '../server/serverLog.js'
import {
  type SessionManager,
  SessionManagerError,
} from '../server/sessionManager.js'
import {
  allowedHosts,
  checkToken,
  COOKIE_NAME,
  cookieHeader,
  readCookie,
  signCookie,
  untrustedReason,
  verifyCookie,
} from './auth.js'

export type WebAsset = { type: string; body: string | Uint8Array }

export type WebServerConfig = {
  host: string
  port: number
  token: string
  cookieKey: Buffer
  workspace: string
  trustedHosts?: string[]
}

type SocketData = { sessionId: string }

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  'frame-src blob:',
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cache-Control': 'no-store',
}

const createSessionBodySchema = lazySchema(() =>
  z.object({
    cwd: z.string().optional(),
    permission_mode: z.enum(PERMISSION_MODES).optional(),
  }),
)

const WS_PATH = /^\/api\/sessions\/([^/]+)\/ws$/
const SESSION_PATH = /^\/api\/sessions\/([^/]+)$/

function withHeaders(res: Response): Response {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(key, value)
  }
  return res
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Browser front end of `claude web`. The page is served only to a browser
 * holding the session cookie, which it gets by opening the printed
 * `/?token=` URL once. `/api` and the WebSocket additionally require the
 * request to come from this server's own origin.
 *
 *   POST   /api/sessions        → { session_id, work_dir }
 *   GET    /api/sessions/:id/ws → stream-json relay to the session
 *   DELETE /api/sessions/:id    → stop the session
 */
export function startWebServer(
  config: WebServerConfig,
  sessionManager: SessionManager,
  assets: Map<string, WebAsset>,
  logger: ServerLogger,
): { port: number; stop: (force?: boolean) => void } {
  let hosts = allowedHosts(config.port, config.trustedHosts)

  async function createSession(req: Request): Promise<Response> {
    let raw: unknown
    try {
      raw = await req.json()
    } catch {
      return errorResponse(400, 'Request body must be JSON')
    }
    const parsed = createSessionBodySchema().safeParse(raw)
    if (!parsed.success) {
      return errorResponse(400, `Invalid request: ${parsed.error.message}`)
    }
    const { cwd, permission_mode: permissionMode } = parsed.data
    let workDir = config.workspace
    if (cwd) {
      if (!isAbsolute(cwd) || !isDirectory(cwd)) {
        return errorResponse(400, `Not a directory: ${cwd}`)
      }
      workDir = cwd
    } else {
      mkdirSync(workDir, { recursive: true })
    }
    try {
      const session = sessionManager.create({ cwd: workDir, permissionMode })
      return Response.json({
        session_id: session.id,
        work_dir: session.workDir,
      })
    } catch (err) {
      if (err instanceof SessionManagerError) {
        return errorResponse(err.status, err.message)
      }
      throw err
    }
  }

  async function handleApi(
    req: Request,
    pathname: string,
    srv: { upgrade: (req: Request, opts: { data: SocketData }) => boolean },
  ): Promise<Response | undefined> {
    if (pathname === '/api/sessions' && req.method === 'POST') {
      return createSession(req)
    }
    const wsMatch = WS_PATH.exec(pathname)
    if (wsMatch && req.method === 'GET') {
      const sessionId = decodeURIComponent(wsMatch[1]!)
      if (!sessionManager.get(sessionId)) {
        return errorResponse(404, 'Session not found')
      }
      if (!sessionManager.canAttach(sessionId)) {
        return errorResponse(409, 'Session is open in another tab')
      }
      if (srv.upgrade(req, { data: { sessionId } })) return undefined
      return errorResponse(400, 'Expected a WebSocket upgrade')
    }
    const sessionMatch = SESSION_PATH.exec(pathname)
    if (sessionMatch && req.method === 'DELETE') {
      const found = await sessionManager.destroy(
        decodeURIComponent(sessionMatch[1]!),
      )
      return found
        ? new Response(null, { status: 204 })
        : errorResponse(404, 'Session not found')
    }
    return errorResponse(404, 'Not found')
  }

  const server = Bun.serve<SocketData, never>({
    hostname: config.host,
    port: config.port,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const { pathname } = url
      const isApi = pathname === '/api' || pathname.startsWith('/api/')
      // Same-origin GETs and page loads may omit Origin; anything that can
      // change state (and every WebSocket handshake) must carry it.
      const requireOrigin =
        req.method !== 'GET' ||
        req.headers.get('upgrade')?.toLowerCase() === 'websocket'
      const reason = untrustedReason(req, hosts, { requireOrigin })
      if (reason) {
        logger.warn(`rejected ${req.method} ${pathname} (untrusted ${reason})`)
        return withHeaders(errorResponse(403, 'Forbidden'))
      }

      if (pathname === '/' && url.searchParams.has('token')) {
        if (!checkToken(config.token, url.searchParams.get('token'))) {
          logger.warn('rejected an invalid token')
          return withHeaders(errorResponse(401, 'Invalid token'))
        }
        return withHeaders(
          new Response(null, {
            status: 302,
            headers: {
              Location: '/',
              'Set-Cookie': cookieHeader(signCookie(config.cookieKey), false),
            },
          }),
        )
      }

      if (!verifyCookie(config.cookieKey, readCookie(req, COOKIE_NAME))) {
        return withHeaders(
          isApi
            ? errorResponse(401, 'Unauthorized')
            : new Response(
                'Open the URL printed by `claude web` in the terminal to sign in.\n',
                {
                  status: 401,
                  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                },
              ),
        )
      }

      if (isApi) {
        const res = await handleApi(req, pathname, srv)
        return res && withHeaders(res)
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return withHeaders(errorResponse(405, 'Method not allowed'))
      }
      const asset = assets.get(pathname) ?? assets.get('/index.html')
      if (!asset) return withHeaders(errorResponse(404, 'Not found'))
      return withHeaders(
        new Response(asset.body, { headers: { 'Content-Type': asset.type } }),
      )
    },
    websocket: {
      open(ws) {
        if (!sessionManager.attach(ws.data.sessionId, ws)) {
          ws.close(1008, 'Session unavailable')
        }
      },
      message(ws, message) {
        sessionManager.write(ws.data.sessionId, message.toString())
      },
      close(ws) {
        sessionManager.detach(ws.data.sessionId, ws)
      },
    },
  })

  const port = server.port ?? config.port
  hosts = allowedHosts(port, config.trustedHosts)
  logger.info(`listening on http://${config.host}:${port}`)
  return {
    port,
    stop: force => {
      void server.stop(force)
    },
  }
}
