import { createHash, timingSafeEqual } from 'crypto'
import { statSync } from 'fs'
import { isAbsolute } from 'path'
import { z } from 'zod/v4'
import { PERMISSION_MODES } from '../types/permissions.js'
import { lazySchema } from '../utils/lazySchema.js'
import type { ServerLogger } from './serverLog.js'
import { type SessionManager, SessionManagerError } from './sessionManager.js'
import type { ServerConfig } from './types.js'

type SocketData = { sessionId: string }

const createSessionBodySchema = lazySchema(() =>
  z.object({
    cwd: z.string().optional(),
    session_key: z.string().optional(),
    permission_mode: z.enum(PERMISSION_MODES).optional(),
  }),
)

const WS_PATH = /^\/sessions\/([^/]+)\/ws$/
const SESSION_PATH = /^\/sessions\/([^/]+)$/

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}

/**
 * HTTP + WebSocket front end of `claude server`:
 *   POST   /sessions          → { session_id, ws_url, work_dir }
 *   GET    /sessions/:id/ws   → WebSocket relaying stream-json to the session
 *   DELETE /sessions/:id      → stop the session
 * Every request must carry `Authorization: Bearer <auth token>`.
 */
export function startServer(
  config: ServerConfig,
  sessionManager: SessionManager,
  logger: ServerLogger,
): { port?: number; stop: (force?: boolean) => void } {
  const expectedAuth = digest(`Bearer ${config.authToken}`)
  const isAuthorized = (req: Request) =>
    timingSafeEqual(
      digest(req.headers.get('authorization') ?? ''),
      expectedAuth,
    )

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
    const {
      cwd,
      permission_mode: permissionMode,
      session_key: sessionKey,
    } = parsed.data

    // The client sends its own cwd; on another machine that path may not
    // exist, in which case the session falls back to --workspace.
    let workDir: string | undefined
    if (cwd && isAbsolute(cwd) && isDirectory(cwd)) workDir = cwd
    else if (config.workspace) workDir = config.workspace
    else if (!cwd) workDir = process.cwd()
    if (!workDir) {
      return errorResponse(
        400,
        `cwd ${cwd} is not a directory on the server (start the server with --workspace to provide a fallback)`,
      )
    }

    let session
    try {
      session = sessionManager.create({
        cwd: workDir,
        permissionMode,
        sessionKey: sessionKey || undefined,
      })
    } catch (err) {
      if (err instanceof SessionManagerError) {
        return errorResponse(err.status, err.message)
      }
      throw err
    }

    const wsUrl = new URL(`/sessions/${session.id}/ws`, req.url)
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    return Response.json({
      session_id: session.id,
      ws_url: wsUrl.toString(),
      work_dir: session.workDir,
      ...(session.sessionKey && { session_key: session.sessionKey }),
    })
  }

  const server = Bun.serve<SocketData, never>({
    ...(config.unix
      ? { unix: config.unix }
      : { hostname: config.host, port: config.port }),
    async fetch(req, srv) {
      const { pathname } = new URL(req.url)
      if (!isAuthorized(req)) {
        logger.warn(`rejected unauthorized ${req.method} ${pathname}`)
        return errorResponse(401, 'Unauthorized')
      }

      if (pathname === '/sessions' && req.method === 'POST') {
        return createSession(req)
      }

      const wsMatch = WS_PATH.exec(pathname)
      if (wsMatch && req.method === 'GET') {
        const sessionId = decodeURIComponent(wsMatch[1]!)
        if (!sessionManager.get(sessionId)) {
          return errorResponse(404, 'Session not found')
        }
        if (!sessionManager.canAttach(sessionId)) {
          return errorResponse(409, 'Session already has a client attached')
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

  logger.info(
    config.unix
      ? `listening on unix socket ${config.unix}`
      : `listening on http://${config.host}:${server.port}`,
  )
  return {
    port: server.port,
    stop: force => {
      void server.stop(force)
    },
  }
}
