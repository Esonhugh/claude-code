import { mkdirSync, mkdtempSync, statSync } from 'fs'
import { basename, extname, isAbsolute, join } from 'path'
import { z } from 'zod/v4'
import { PERMISSION_MODES } from '../types/permissions.js'
import { lazySchema } from '../utils/lazySchema.js'
import type { ServerLogger } from '../server/serverLog.js'
import {
  type SessionManager,
  SessionManagerError,
} from '../server/sessionManager.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import {
  convertToPdf,
  DEFAULT_UPLOAD_LIMITS,
  resolveAllowedFile,
  saveUpload,
  transcriptFileScope,
  UploadError,
  type UploadLimits,
} from './files.js'
import {
  AGENT_ID,
  findAgentIssuers,
  listHistory,
  readAgentTranscript,
  readTranscript,
  renameSession,
  SESSION_ID,
} from './history.js'
import { isAllowedPeer, lanHostNames } from './network.js'
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
  /** Uploads land in `<uploadsDir>/<session id>/`. */
  uploadsDir: string
  uploadLimits?: UploadLimits
  /** Defaults to the claude config dir; files under it are not served. */
  configDir?: string
  trustedHosts?: string[]
  /** Also answer to this machine's LAN addresses and `<hostname>.local`. */
  allowLocalNetwork?: boolean
  /** PEM file paths; when set the server speaks https/wss only. */
  tls?: { cert: string; key: string }
  /** Origins from `parsePreviewOrigin` that the page may frame. */
  previewOrigins?: string[]
}

type SocketData = { sessionId: string }

// CSP host sources cannot name IPv6 literals, so `[::1]` is not listed.
const LOOPBACK_FRAME_SOURCES = ['localhost', '127.0.0.1'].flatMap(host => [
  `http://${host}:*`,
  `https://${host}:*`,
])

/** The page's CSP; loopback dev servers and `--preview-origin`s may be framed. */
export function contentSecurityPolicy(previewOrigins: string[] = []): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    ['frame-src blob:', ...LOOPBACK_FRAME_SOURCES, ...previewOrigins].join(' '),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/**
 * A `--preview-origin` value as a bare origin (`http://host:port`), or
 * undefined unless it is http(s) with no credentials, path, query, fragment
 * or wildcard. The result goes into the CSP, so nothing else may get through.
 */
export function parsePreviewOrigin(value: string): string | undefined {
  if (/[*?#\s]/.test(value)) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username || url.password || url.pathname !== '/') return undefined
  // WHATWG hosts may still hold `;` or `,`, which would split the CSP, and
  // CSP host sources cannot name IPv6 literals.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(url.hostname)) {
    return undefined
  }
  return url.origin
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cache-Control': 'no-store',
}

const createSessionBodySchema = lazySchema(() =>
  z.object({
    cwd: z.string().optional(),
    // A temporary chat: a fresh empty folder under `<config>/web/temp`.
    temporary: z.boolean().optional(),
    resume: z.string().regex(SESSION_ID).optional(),
    permission_mode: z.enum(PERMISSION_MODES).optional(),
    // A model alias or id; passed to `--model` as one argv entry.
    model: z
      .string()
      .regex(/^[A-Za-z0-9][\w.:[\]/@-]{0,127}$/)
      .optional(),
  }),
)

const WS_PATH = /^\/api\/sessions\/([^/]+)\/ws$/
const SESSION_PATH = /^\/api\/sessions\/([^/]+)$/
const HISTORY_PATH = /^\/api\/history\/([^/]+)$/
const HISTORY_MESSAGES_PATH = /^\/api\/history\/([^/]+)\/messages$/
const AGENT_MESSAGES_PATH = /^\/api\/history\/([^/]+)\/agents\/([^/]+)\/messages$/
const AGENT_ISSUERS_PATH = /^\/api\/history\/([^/]+)\/agent-issuers$/
const FILES_PATH = /^\/api\/files\/([^/]+)(\/pdf)?$/

// Served as text so a file from the workspace never runs as a page on this origin.
const ACTIVE_TYPES = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml', '.js', '.mjs'])

function fileResponse(req: Request, path: string, download: boolean): Response {
  const file = Bun.file(path)
  const size = file.size
  const ext = extname(path).toLowerCase()
  const type = ACTIVE_TYPES.has(ext)
    ? 'text/plain; charset=utf-8'
    : file.type || 'application/octet-stream'
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start > end || start >= size) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      })
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}` },
    })
  }
  return new Response(file, { headers })
}

const renameBodySchema = lazySchema(() =>
  z.object({ title: z.string().trim().min(1).max(200) }),
)

function intParam(url: URL, name: string, fallback: number, max: number): number {
  const value = Number(url.searchParams.get(name) ?? fallback)
  return Number.isInteger(value) && value >= 0 ? Math.min(value, max) : fallback
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return undefined
  }
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}

type Listener = ReturnType<typeof Bun.serve>

/**
 * `0.0.0.0` means every interface: bind `::` first (dual-stack on most
 * systems), fall back to IPv4 when there is no IPv6, and add an IPv4 socket
 * on the same port where `::` is IPv6-only.
 */
function listen(
  host: string,
  port: number,
  serve: (hostname: string, port: number) => Listener,
): Listener[] {
  if (host !== '0.0.0.0') return [serve(host, port)]
  let v6: Listener
  try {
    v6 = serve('::', port)
  } catch {
    return [serve('0.0.0.0', port)]
  }
  try {
    return [v6, serve('0.0.0.0', v6.port ?? port)]
  } catch {
    return [v6]
  }
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
 *   GET    /api/info                    → { workspace, preview_origins, temp_root }
 *   GET    /api/sessions                → running sessions
 *   POST   /api/sessions                → { session_id, work_dir } (new or resume)
 *   GET    /api/sessions/:id/ws         → stream-json relay to the session
 *   DELETE /api/sessions/:id            → stop the session
 *   GET    /api/history                 → transcripts on disk, newest first
 *   GET    /api/history/:id/messages    → a page of one transcript
 *   PATCH  /api/history/:id             → rename (custom title)
 *   GET    /api/history/:id/agents/:agent/messages → a subagent's transcript
 *   GET    /api/history/:id/agent-issuers?tool_use_id= → { [tool use id]: agent id }
 *   POST   /api/files/:id?name=         → upload into the session's folder
 *   GET    /api/files/:id?path=         → a file the session may show (Range)
 *   GET    /api/files/:id/pdf?path=     → Office document converted to PDF
 */
export function startWebServer(
  config: WebServerConfig,
  sessionManager: SessionManager,
  assets: Map<string, WebAsset>,
  logger: ServerLogger,
): { port: number; stop: (force?: boolean) => void } {
  const extraHosts = [
    ...(config.trustedHosts ?? []),
    ...(config.allowLocalNetwork ? lanHostNames() : []),
  ]
  let hosts = allowedHosts(config.port, extraHosts)
  const previewOrigins = config.previewOrigins ?? []
  const tempRoot = join(config.configDir ?? getClaudeConfigHomeDir(), 'web', 'temp')
  const csp = contentSecurityPolicy(previewOrigins)
  const withHeaders = (res: Response): Response => {
    res.headers.set('Content-Security-Policy', csp)
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      res.headers.set(key, value)
    }
    return res
  }
  const uploadLimits = config.uploadLimits ?? DEFAULT_UPLOAD_LIMITS

  async function sessionFile(id: string, path: string): Promise<string | undefined> {
    if (!isAbsolute(path)) return undefined
    const running = sessionManager.get(id)
    const transcript = await transcriptFileScope(id)
    const cwd = running?.workDir ?? transcript.cwd
    return resolveAllowedFile(path, {
      roots: [join(config.uploadsDir, id), ...(cwd ? [cwd] : [])],
      files: transcript.files,
      configDir: config.configDir ?? getClaudeConfigHomeDir(),
    })
  }

  async function handleFiles(
    req: Request,
    url: URL,
    id: string,
    pdf: boolean,
  ): Promise<Response> {
    if (!SESSION_ID.test(id)) return errorResponse(400, 'Invalid session id')
    if (req.method === 'POST' && !pdf) {
      const length = Number(req.headers.get('content-length'))
      if (!Number.isFinite(length) || length <= 0) {
        return errorResponse(411, 'Content-Length required')
      }
      if (length > uploadLimits.fileBytes) {
        return errorResponse(413, 'File is larger than the upload limit')
      }
      try {
        const saved = await saveUpload(
          config.uploadsDir,
          id,
          url.searchParams.get('name') ?? 'upload',
          await req.arrayBuffer(),
          uploadLimits,
        )
        return Response.json(saved)
      } catch (err) {
        if (err instanceof UploadError) return errorResponse(err.status, err.message)
        throw err
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return errorResponse(405, 'Method not allowed')
    }
    const file = await sessionFile(id, url.searchParams.get('path') ?? '')
    if (!file) return errorResponse(404, 'File not found')
    if (!pdf) return fileResponse(req, file, url.searchParams.has('download'))
    const converted = await convertToPdf(file)
    return converted
      ? fileResponse(req, converted, false)
      : errorResponse(501, 'No converter available for this file')
  }

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
    const { cwd, temporary, resume, permission_mode: permissionMode, model } = parsed.data
    let workDir = config.workspace
    if (temporary && !cwd && !resume) {
      mkdirSync(tempRoot, { recursive: true })
      workDir = mkdtempSync(join(tempRoot, 'chat-'))
    } else if (cwd) {
      if (!isAbsolute(cwd) || !isDirectory(cwd)) {
        return errorResponse(400, `Not a directory: ${cwd}`)
      }
      workDir = cwd
    } else {
      mkdirSync(workDir, { recursive: true })
    }
    try {
      const session = sessionManager.create({
        cwd: workDir,
        permissionMode,
        model,
        resume,
      })
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
    url: URL,
    srv: { upgrade: (req: Request, opts: { data: SocketData }) => boolean },
  ): Promise<Response | undefined> {
    const { pathname } = url
    if (pathname === '/api/info' && req.method === 'GET') {
      return Response.json({
        workspace: config.workspace,
        preview_origins: previewOrigins,
        temp_root: tempRoot,
      })
    }
    if (pathname === '/api/sessions' && req.method === 'POST') {
      return createSession(req)
    }
    if (pathname === '/api/sessions' && req.method === 'GET') {
      return Response.json(
        sessionManager.list().map(s => ({
          id: s.id,
          work_dir: s.workDir,
          status: s.status,
          attached: s.attached,
        })),
      )
    }
    if (pathname === '/api/history' && req.method === 'GET') {
      return Response.json(
        await listHistory(
          intParam(url, 'offset', 0, 100_000),
          intParam(url, 'limit', 50, 200),
        ),
      )
    }
    const messagesMatch = HISTORY_MESSAGES_PATH.exec(pathname)
    if (messagesMatch && req.method === 'GET') {
      const id = decodeURIComponent(messagesMatch[1]!)
      if (!SESSION_ID.test(id)) return errorResponse(400, 'Invalid session id')
      const before = url.searchParams.has('before')
        ? intParam(url, 'before', 0, Number.MAX_SAFE_INTEGER)
        : undefined
      const page = await readTranscript(id, before, intParam(url, 'limit', 200, 500))
      return page ? Response.json(page) : errorResponse(404, 'Session not found')
    }
    const agentMatch = AGENT_MESSAGES_PATH.exec(pathname)
    if (agentMatch && req.method === 'GET') {
      const id = decodeURIComponent(agentMatch[1]!)
      const agentId = decodeURIComponent(agentMatch[2]!)
      if (!SESSION_ID.test(id) || !AGENT_ID.test(agentId)) {
        return errorResponse(400, 'Invalid id')
      }
      const page = await readAgentTranscript(id, agentId)
      return page ? Response.json(page) : errorResponse(404, 'Agent not found')
    }
    const issuersMatch = AGENT_ISSUERS_PATH.exec(pathname)
    if (issuersMatch && req.method === 'GET') {
      const id = decodeURIComponent(issuersMatch[1]!)
      const toolUseIds = url.searchParams.getAll('tool_use_id')
      if (!SESSION_ID.test(id) || toolUseIds.length > 100 || !toolUseIds.every(t => AGENT_ID.test(t))) {
        return errorResponse(400, 'Invalid id')
      }
      return Response.json(await findAgentIssuers(id, toolUseIds))
    }
    const historyMatch = HISTORY_PATH.exec(pathname)
    if (historyMatch && req.method === 'PATCH') {
      const id = decodeURIComponent(historyMatch[1]!)
      if (!SESSION_ID.test(id)) return errorResponse(400, 'Invalid session id')
      const parsed = renameBodySchema().safeParse(await readJson(req))
      if (!parsed.success) return errorResponse(400, 'Invalid title')
      return (await renameSession(id, parsed.data.title))
        ? new Response(null, { status: 204 })
        : errorResponse(404, 'Session not found')
    }
    const filesMatch = FILES_PATH.exec(pathname)
    if (filesMatch) {
      return handleFiles(req, url, decodeURIComponent(filesMatch[1]!), !!filesMatch[2])
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

  const serve = (hostname: string, port: number) =>
    Bun.serve<SocketData, never>({
      hostname,
      port,
      tls: config.tls && {
        cert: Bun.file(config.tls.cert),
        key: Bun.file(config.tls.key),
      },
      async fetch(req, srv) {
        // Before anything else: only loopback and LAN peers are served.
        const peer = srv.requestIP(req)?.address
        if (!isAllowedPeer(peer)) {
          logger.warn(`rejected a connection from ${peer ?? 'an unknown address'}`)
          return new Response(null, { status: 403 })
        }
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
                'Set-Cookie': cookieHeader(
                  signCookie(config.cookieKey),
                  config.tls !== undefined,
                ),
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
          const res = await handleApi(req, url, srv)
          return res && withHeaders(res)
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return withHeaders(errorResponse(405, 'Method not allowed'))
        }
        const asset = assets.get(pathname) ?? assets.get('/index.html')
        if (!asset) return withHeaders(errorResponse(404, 'Not found'))
        return withHeaders(
          new Response(asset.body as BodyInit, { headers: { 'Content-Type': asset.type } }),
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

  const servers = listen(config.host, config.port, serve)
  const port = servers[0]!.port ?? config.port
  hosts = allowedHosts(port, extraHosts)
  logger.info(
    `listening on ${config.tls ? 'https' : 'http'}://${servers.map(s => s.hostname).join(', ')} port ${port}`,
  )
  return {
    port,
    stop: force => {
      for (const server of servers) void server.stop(force)
    },
  }
}
