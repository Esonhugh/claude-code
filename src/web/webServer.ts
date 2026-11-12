import type { Database } from 'bun:sqlite'
import { spawn } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { z } from 'zod/v4'
import { addToHistory, getTimestampedHistory } from '../history.js'
import { PERMISSION_MODES } from '../types/permissions.js'
import { getAPIProvider } from '../utils/model/providers.js'
import { lazySchema } from '../utils/lazySchema.js'
import { MCP_APP_FRAME_CSP, MCP_APP_FRAME_HTML, MCP_APP_FRAME_PATH } from './mcpAppFrame.js'
import { MODS_FRAME_CSP, MODS_FRAME_HTML, MODS_FRAME_PATH } from './modsFrame.js'
import { getMainLoopModel } from '../utils/model/model.js'
import { getModelInfos } from '../utils/model/modelInfos.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { ensureModelStringsInitialized } from '../utils/model/modelStrings.js'
import type { ServerLogger } from '../server/serverLog.js'
import {
  type SessionManager,
  SessionManagerError,
} from '../server/sessionManager.js'
import { isPathTrusted, savePathTrusted } from '../utils/config.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { formatPeerAddress } from '../utils/peerProtocol.js'
import { listAllLiveSessions } from '../utils/udsClient.js'
import { resolveSessionFilePath } from '../utils/sessionStoragePortable.js'
import {
  convertToPdf,
  DEFAULT_UPLOAD_LIMITS,
  listWorkspaceFiles,
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
  readSnippet,
  readTranscript,
  forkSession,
  renameSession,
  SESSION_ID,
} from './history.js'
import { type AccountBackend, createAccountApi } from './account.js'
import { coordinatorSpawn } from './coordinator.js'
import {
  deleteSessionMeta,
  openProjectsDb,
  patchSessionMeta,
  patchSessionSettings,
  type Project,
  ProjectStore,
  readSessionSettings,
  type SessionSettings,
} from './projectsDb.js'
import { deleteTranscript, loadSidebar } from './sidebar.js'
import { parseLine, type Task, TaskStore, transcriptTokens } from './tasks.js'
import * as ext from './extensions.js'
import { addressKind, isAllowedPeer, lanHostNames } from './network.js'
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
  /** Folder trust as the TUI's trust dialog records it; replaceable in tests. */
  folderTrust?: { isTrusted: (dir: string) => boolean; save: (dir: string) => void }
  /** Defaults to this machine's credential store and settings (tests pass a fake). */
  account?: AccountBackend
  /** Defaults to `<configDir>/web/projects.sqlite`; tests pass `:memory:`. */
  projectsDb?: string
  /** Opens a file or folder with the OS default app; resolves to an error message. Tests pass a fake. */
  openLocal?: (path: string) => Promise<string | undefined>
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
    ["frame-src 'self' blob:", ...LOOPBACK_FRAME_SOURCES, ...previewOrigins].join(' '),
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

const openBodySchema = lazySchema(() =>
  z.object({ path: z.string().max(4096).optional(), reveal: z.boolean().optional() }),
)

const createSessionBodySchema = lazySchema(() =>
  z.object({
    cwd: z.string().optional(),
    // A temporary chat: a fresh empty folder under `<config>/web/temp`.
    temporary: z.boolean().optional(),
    resume: z.string().regex(SESSION_ID).optional(),
    // The user accepted the trust confirmation for `cwd` (the TUI's trust dialog).
    trust: z.boolean().optional(),
    permission_mode: z.enum(PERMISSION_MODES).optional(),
    // A model alias or id; passed to `--model` as one argv entry.
    model: z
      .string()
      .regex(/^[A-Za-z0-9][\w.:[\]/@-]{0,127}$/)
      .optional(),
    // An effort level, passed to `--effort` (a resumed session keeps the one the page showed).
    effort: z.string().regex(EFFORT).optional(),
  }),
)

// A prompt the page sent, kept in the CLI's ↑ history (`history.jsonl`) under its folder.
const promptHistoryBodySchema = lazySchema(() =>
  z.object({
    cwd: z.string().min(1),
    session_id: z.string().regex(SESSION_ID).optional(),
    text: z.string().trim().min(1).max(100_000),
  }),
)

const MODEL = /^[A-Za-z0-9][\w.:[\]/@-]{0,127}$/

const projectFieldsSchema = lazySchema(() =>
  z.object({
    name: z.string().trim().min(1).max(200),
    instructions: z.string().max(20_000).optional(),
    // A model alias or id for CLAUDE_CODE_SUBAGENT_MODEL; null inherits the coordinator's.
    worker_model: z.string().regex(MODEL).nullable().optional(),
    // CLAUDE_CODE_SUBAGENT_EFFORT; null inherits the coordinator's.
    worker_effort: z.string().regex(EFFORT).nullable().optional(),
    permission_mode: z.enum(PERMISSION_MODES).optional(),
  }),
)
const createProjectBodySchema = lazySchema(() =>
  projectFieldsSchema()
    .extend({
      cwd: z.string().min(1).max(4096),
      // The user accepted the trust confirmation for `cwd`.
      trust: z.boolean().optional(),
    })
    .strict(),
)
const patchProjectBodySchema = lazySchema(() => projectFieldsSchema().partial().strict())

/**
 * A project folder as an absolute, normalized real path: `~` is the home
 * folder, anything else must already be absolute. Undefined unless it is a
 * folder.
 */
export function normalizeProjectDir(input: string, home = homedir()): string | undefined {
  const raw = input.trim()
  const expanded = raw === '~' ? home : /^~[\\/]/.test(raw) ? join(home, raw.slice(2)) : raw
  if (!isAbsolute(expanded) || expanded.includes('\0')) return undefined
  const path = resolve(expanded)
  return isDirectory(path) ? realpathSync(path) : undefined
}

const WS_PATH = /^\/api\/sessions\/([^/]+)\/ws$/
const SESSION_PATH = /^\/api\/sessions\/([^/]+)$/
const OPEN_PATH = /^\/api\/sessions\/([^/]+)\/open$/
const SESSION_META_PATH = /^\/api\/sessions\/([^/]+)\/meta$/
const HISTORY_PATH = /^\/api\/history\/([^/]+)$/
const HISTORY_MESSAGES_PATH = /^\/api\/history\/([^/]+)\/messages$/
const AGENT_MESSAGES_PATH = /^\/api\/history\/([^/]+)\/agents\/([^/]+)\/messages$/
const AGENT_ISSUERS_PATH = /^\/api\/history\/([^/]+)\/agent-issuers$/
const FILES_PATH = /^\/api\/files\/([^/]+)(\/pdf|\/list)?$/
const SNIPPET_PATH = /^\/api\/history\/([^/]+)\/snippet$/
const FORK_PATH = /^\/api\/history\/([^/]+)\/fork$/
const PROJECT_PATH = /^\/api\/projects\/([^/]+)(?:\/(coordinator|tasks)(?:\/([^/]+)(?:\/(transcript|review))?)?)?$/
const EFFORT = /^[a-z]{1,20}$/

// Served as text so a file from the workspace never runs as a page on this origin.
// Markup and script would run as this origin (with the page's API), so they are shown as text.
// Decided by the served type: Bun maps more extensions to these than any list here (.shtml, .xht, .cjs, .ts…).
const ACTIVE_TYPE = /html|xml|javascript|ecmascript/i

function fileResponse(req: Request, path: string, download: boolean): Response {
  const file = Bun.file(path)
  const size = file.size
  const type = ACTIVE_TYPE.test(file.type)
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

// The sidebar's marks on a session; `title: null` drops a rename.
const sessionMetaBodySchema = lazySchema(() =>
  z
    .strictObject({
      title: z.string().trim().min(1).max(200).nullable().optional(),
      pinned: z.boolean().optional(),
      unread: z.boolean().optional(),
      archived: z.boolean().optional(),
      project_id: z.string().regex(/^[\w-]{1,100}$/).nullable().optional(),
    })
    .refine(body => Object.keys(body).length > 0),
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

const EXT_PATH = /^\/api\/ext\/([a-z]+)(?:\/([^/]+))?(?:\/([a-z]+))?$/
const onBodySchema = lazySchema(() => z.object({ on: z.boolean() }))
const idBodySchema = lazySchema(() => z.object({ id: z.string().max(300) }))
const pluginBodySchema = lazySchema(() =>
  z.object({
    id: z.string().max(300),
    action: z.enum(['install', 'uninstall', 'enable', 'disable', 'update']),
  }),
)
const marketplaceBodySchema = lazySchema(() =>
  z.object({ source: z.string().max(500) }).or(
    z.object({ name: z.string().max(200), action: z.enum(['refresh', 'remove']) }),
  ),
)
const channelBodySchema = lazySchema(() => z.object({ plugin: z.string().max(300), on: z.boolean() }))
const memoryToggleSchema = lazySchema(() => z.object({ key: z.enum(['autoMemory', 'sqlite']), on: z.boolean() }))
const modSourceSchema = lazySchema(() => z.object({ source: z.string().max(512 * 1024) }))

async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJson(req))
  if (!parsed.success) throw new ext.ExtError('Invalid request')
  return parsed.data
}

/**
 * The sidebar dialogs' data and actions (see extensions.ts).
 *
 *   GET  /api/ext/skills                 → skills with group, source and on/off
 *   GET  /api/ext/skills/:name           → { content } of its SKILL.md
 *   PUT  /api/ext/skills/:name {on}      → skillOverrides in local settings
 *   GET  /api/ext/plugins                → { installed, discover, marketplaces }
 *   POST /api/ext/plugins {id, action}   → install/uninstall/enable/disable/update
 *   POST /api/ext/marketplaces {source} | {name, action}
 *   GET  /api/ext/channels               → channel plugins and their defaults
 *   PUT  /api/ext/channels {plugin, on}  → default `--channels` for new sessions
 *   GET  /api/ext/memory                 → memory files, auto memory, FTS index
 *   GET  /api/ext/memory/search?q=&scope=
 *   PUT  /api/ext/memory {key, on}       → autoMemoryEnabled / memory.sqlite.enabled
 *   GET  /api/ext/hooks                  → hooks by source, disableAllHooks
 *   POST/PUT/DELETE /api/ext/hooks       → add / {id,...} edit / {id} delete
 *   PUT  /api/ext/hooks/disabled {on}
 *   GET  /api/ext/mods                   → plugins with hook modules
 *   GET|PUT /api/ext/mods/:id/source     → entry module source
 *   PUT  /api/ext/mods/:id {on}
 *   GET  /api/ext/stats                  → daily tokens/sessions, streaks, hours
 */
async function handleExtApi(req: Request, url: URL, configDir: string): Promise<Response> {
  const match = EXT_PATH.exec(url.pathname)
  if (!match) return errorResponse(404, 'Not found')
  const [, area, rawArg, sub] = match
  const arg = rawArg === undefined ? undefined : decodeURIComponent(rawArg)
  const route = `${req.method} ${area}${arg === undefined ? '' : '/:arg'}${sub ? `/${sub}` : ''}`
  const ok = () => new Response(null, { status: 204 })
  try {
    switch (route) {
      case 'GET skills':
        return Response.json(await ext.listSkills())
      case 'GET skills/:arg':
        return Response.json(await ext.skillContent(arg!))
      case 'PUT skills/:arg':
        await ext.setSkillEnabled(arg!, (await parseBody(req, onBodySchema())).on)
        return ok()
      case 'GET plugins':
        return Response.json(await ext.listPlugins())
      case 'POST plugins': {
        const body = await parseBody(req, pluginBodySchema())
        return Response.json(await ext.pluginAction(body.action, body.id))
      }
      case 'POST marketplaces': {
        const body = await parseBody(req, marketplaceBodySchema())
        if ('source' in body) return Response.json(await ext.addMarketplace(body.source))
        await ext.marketplaceAction(body.action, body.name)
        return ok()
      }
      case 'GET channels':
        return Response.json(await ext.listChannels(configDir))
      case 'PUT channels': {
        const body = await parseBody(req, channelBodySchema())
        await ext.setDefaultChannel(configDir, body.plugin, body.on)
        return ok()
      }
      case 'GET memory':
        return Response.json(await ext.listMemory())
      case 'GET memory/:arg':
        if (arg !== 'search') break
        return Response.json(
          await ext.searchMemoryIndex(
            url.searchParams.get('q') ?? '',
            (['memory', 'session'] as const).find(s => s === url.searchParams.get('scope')) ?? 'all',
          ),
        )
      case 'PUT memory': {
        const body = await parseBody(req, memoryToggleSchema())
        ext.setMemoryToggle(body.key, body.on)
        return ok()
      }
      case 'GET hooks':
        return Response.json(await ext.listHooks())
      case 'POST hooks':
        ext.addHook(await parseBody(req, ext.hookInputSchema))
        return ok()
      case 'PUT hooks': {
        const body = await parseBody(req, ext.hookInputSchema.extend({ id: z.string().max(300) }))
        ext.updateHook(body.id, body)
        return ok()
      }
      case 'DELETE hooks':
        ext.deleteHook((await parseBody(req, idBodySchema())).id)
        return ok()
      case 'PUT hooks/:arg':
        if (arg !== 'disabled') break
        ext.setHooksDisabled((await parseBody(req, onBodySchema())).on)
        return ok()
      case 'GET mods':
        return Response.json(await ext.listMods())
      case 'PUT mods/:arg':
        return Response.json(await ext.setModEnabled(arg!, (await parseBody(req, onBodySchema())).on))
      case 'GET mods/:arg/source':
        return Response.json(await ext.modSource(arg!))
      case 'PUT mods/:arg/source':
        await ext.saveModSource(arg!, (await parseBody(req, modSourceSchema())).source)
        return ok()
      case 'GET stats':
        return Response.json(await ext.loadStats())
    }
  } catch (err) {
    if (err instanceof ext.ExtError) return errorResponse(err.status, err.message)
    return errorResponse(500, err instanceof Error ? err.message : String(err))
  }
  return errorResponse(404, 'Not found')
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

function realOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Opens `path` with the OS default app (a folder in the file manager) on this machine.
 * Resolves to an error message, or undefined once the opener exited cleanly or is still
 * running after a moment: some openers stay in the foreground until the window closes.
 */
export function openLocal(path: string): Promise<string | undefined> {
  const win = process.platform === 'win32'
  const command = win ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  return new Promise(done => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [path], { detached: true, stdio: 'ignore', windowsHide: true })
    } catch (err) {
      done(`${command}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const timer = setTimeout(() => {
      child.unref()
      done(undefined)
    }, 3000)
    child.once('error', err => {
      clearTimeout(timer)
      done(`${command}: ${err.message}`)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      // explorer.exe exits 1 even when it opened the window.
      done(code === 0 || win ? undefined : `${command} exited with code ${code}`)
    })
  })
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
 *   GET    /api/info                    → { workspace, preview_origins, temp_root, home, version }
 *   GET    /api/models                  → { models, model } the model picker lists before any session runs, and the model one started without a pick runs
 *   GET    /api/sessions                → running sessions
 *   POST   /api/sessions                → { session_id, work_dir } (new or resume);
 *                                          409 { needs_trust } for an untrusted folder
 *   GET    /api/sessions/:id/ws         → stream-json relay to the session
 *   DELETE /api/sessions/:id            → stop the session
 *   DELETE /api/sessions/:id?transcript=1 → stop it and delete its transcript
 *   PATCH  /api/sessions/:id/meta       → pin, unread, rename, archive, move to project
 *   GET    /api/sidebar?limit=          → sessions with their marks, folders' last change
 *   GET    /api/prompt-history?cwd=     → { prompts } the folder's ↑ history, newest first (the CLI's too)
 *   POST   /api/prompt-history          → add a prompt the page sent to that history
 *   GET    /api/history                 → transcripts on disk, newest first
 *   GET    /api/history/:id/messages    → a page of one transcript
 *   PATCH  /api/history/:id             → rename (custom title)
 *   GET    /api/history/:id/agents/:agent/messages → a subagent's transcript
 *   GET    /api/history/:id/agent-issuers?tool_use_id= → { [tool use id]: agent id }
 *   GET    /api/history/:id/snippet     → { snippet } first assistant text
 *   GET    /api/folder-files?cwd=&q=    → { files } `@` search in a trusted folder before a session exists
 *   POST   /api/files/:id?name=         → upload into the session's folder
 *   GET    /api/files/:id/list?q=       → { files } for `@` completion
 *   GET    /api/files/:id?path=         → a file the session may show (Range)
 *   GET    /api/files/:id/pdf?path=     → Office document converted to PDF
 *   /api/account*, /api/settings, /api/usage → see createAccountApi
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
  let accountApi: ReturnType<typeof createAccountApi> | undefined
  const handleAccount = async (req: Request, url: URL) => {
    accountApi ??= createAccountApi(
      config.account ?? (await import('./accountBackend.js')).localAccountBackend(),
      { allowLocalNetwork: config.allowLocalNetwork === true },
    )
    return accountApi(req, url)
  }

  async function sessionCwd(id: string): Promise<string | undefined> {
    return sessionManager.get(id)?.workDir ?? (await transcriptFileScope(id)).cwd
  }

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
    kind: string | undefined,
  ): Promise<Response> {
    if (!SESSION_ID.test(id)) return errorResponse(400, 'Invalid session id')
    const pdf = kind === '/pdf'
    if (kind === '/list') {
      if (req.method !== 'GET') return errorResponse(405, 'Method not allowed')
      const cwd = await sessionCwd(id)
      const files = cwd
        ? await listWorkspaceFiles(cwd, (url.searchParams.get('q') ?? '').slice(0, 200), {
            configDir: config.configDir ?? getClaudeConfigHomeDir(),
          })
        : []
      return Response.json({ files })
    }
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

  /** A 409 asking the page to confirm trust in `directory`, unless it is trusted (or now accepted). */
  function checkTrust(directory: string, accepted: boolean | undefined): Response | undefined {
    const folderTrust = config.folderTrust ?? { isTrusted: isPathTrusted, save: savePathTrusted }
    if (directory === realOr(config.workspace) || folderTrust.isTrusted(directory)) return undefined
    if (!accepted) return Response.json({ error: 'Folder not trusted', needs_trust: directory }, { status: 409 })
    folderTrust.save(directory)
    return undefined
  }

  let projectsDb: Database | undefined
  let taskStore: TaskStore | undefined
  const db = () => {
    if (projectsDb) return projectsDb
    projectsDb = openProjectsDb(
      config.projectsDb ?? join(config.configDir ?? getClaudeConfigHomeDir(), 'web', 'projects.sqlite'),
    )
    // Workers that were running died with the previous server.
    taskStore = new TaskStore(projectsDb)
    taskStore.stopLive('restart')
    return projectsDb
  }
  const tasks = () => (db(), taskStore!)
  let projectStore: ProjectStore | undefined
  const projects = () => (projectStore ??= new ProjectStore(db()))
  const projectJson = (p: Project, counts = tasks().counts()) => {
    const count = counts.get(p.id)
    return {
      ...p,
      running: !!p.coordinator_session_id && !!sessionManager.get(p.coordinator_session_id),
      task_count: count?.tasks ?? 0,
      running_tasks: count?.running ?? 0,
      needs_you: count?.needsYou ?? 0,
    }
  }

  // Coordinator session id → its project, for the lines the session manager relays.
  const coordinators = new Map<string, string>()
  // The coordinator's own set_model / effort requests in flight, kept once it accepts them.
  const settingRequests = new Map<string, { projectId: string; patch: Pick<Project, 'coordinator_model'> | Pick<Project, 'coordinator_effort'> }>()
  // Messages the page sent a session's agent or teammate (queued, resuming it, or
  // injected for a teammate's next turn), shown in
  // the agent's conversation from the moment they are sent until its transcript
  // has them (`withQueued`). A resumed agent writes its prompt up to 100 ms later,
  // so without it a message queued right after would show above that prompt.
  const agentSends = new Map<string, { taskId: string; text: string; ts: number }>()
  const agentQueued = new Map<string, { id: number; ts: number; text: string }[]>()
  let agentQueuedId = 0
  const watchAgentSend = (sessionId: string, line: string, from: 'child' | 'client') => {
    if (from === 'client') {
      if (!line.includes('"send_task_message"')) return
      const msg = parseLine(line)
      const request = (msg?.request ?? {}) as Record<string, unknown>
      if (
        msg?.type === 'control_request' &&
        request.subtype === 'send_task_message' &&
        typeof msg.request_id === 'string' &&
        typeof request.task_id === 'string' &&
        typeof request.text === 'string'
      ) {
        agentSends.set(`${sessionId}:${msg.request_id}`, { taskId: request.task_id, text: request.text, ts: Date.now() })
      }
      return
    }
    if (!agentSends.size || !line.includes('"control_response"')) return
    const response = parseLine(line)?.response as { request_id?: unknown; subtype?: unknown; response?: { delivery?: unknown; agent_id?: unknown } } | undefined
    const key = `${sessionId}:${String(response?.request_id)}`
    const sent = agentSends.get(key)
    if (!sent) return
    agentSends.delete(key)
    const delivery = response!.response?.delivery
    if (response!.subtype !== 'success' || (delivery !== 'queued' && delivery !== 'resumed' && delivery !== 'injected')) return
    // A teammate answers with the agent id its transcript is read by.
    const agentId = typeof response!.response?.agent_id === 'string' ? response!.response.agent_id : sent.taskId
    const queued = agentQueued.get(`${sessionId}:${agentId}`) ?? []
    agentQueued.set(`${sessionId}:${agentId}`, [...queued, { id: ++agentQueuedId, ts: sent.ts, text: sent.text }])
  }
  // Each session's model, effort, context window and permission mode, kept once the session accepts them,
  // for a page that opens it again after its process is gone. Keyed by `<session id>:<request id>`.
  const sessionSettingRequests = new Map<string, Partial<Omit<SessionSettings, 'provider'>>>()
  // The provider each session's process started under (an account switch since does not change it).
  const sessionProviders = new Map<string, string>()
  const saveSessionSettings = (sessionId: string, patch: Partial<Omit<SessionSettings, 'provider'>>) =>
    patchSessionSettings(db(), sessionId, sessionProviders.get(sessionId) ?? getAPIProvider(), patch)
  const watchSessionSettings = (sessionId: string, line: string, from: 'child' | 'client') => {
    if (!line.includes('"control_')) return
    if (from === 'child') {
      if (!sessionSettingRequests.size || !line.includes('"type":"control_response"')) return
      const response = parseLine(line)?.response as { request_id?: unknown; subtype?: unknown } | undefined
      const key = `${sessionId}:${String(response?.request_id)}`
      const patch = sessionSettingRequests.get(key)
      if (!patch) return
      sessionSettingRequests.delete(key)
      if (response!.subtype === 'success') saveSessionSettings(sessionId, patch)
      return
    }
    if (!line.includes('"type":"control_request"')) return
    const msg = parseLine(line)
    const request = (msg?.request ?? {}) as Record<string, unknown>
    if (typeof msg?.request_id !== 'string') return
    let patch: Partial<Omit<SessionSettings, 'provider'>> | undefined
    if (request.subtype === 'set_model' && typeof request.model === 'string') {
      // A model switch also resets the effort to the new model's own.
      patch = { model: request.model === 'default' || !MODEL.test(request.model) ? null : request.model, effort: null }
    } else if (request.subtype === 'set_permission_mode' && (PERMISSION_MODES as readonly unknown[]).includes(request.mode)) {
      patch = { permission_mode: request.mode as string }
    } else if (request.subtype === 'apply_flag_settings') {
      const settings = (request.settings ?? {}) as { effortLevel?: unknown; autoCompactWindow?: unknown }
      patch = {
        ...(typeof settings.effortLevel === 'string' && EFFORT.test(settings.effortLevel) && { effort: settings.effortLevel }),
        ...(typeof settings.autoCompactWindow === 'number' && { context_window: settings.autoCompactWindow }),
        ...(settings.autoCompactWindow === 'auto' && { context_window: null }),
      }
    }
    if (patch && Object.keys(patch).length) sessionSettingRequests.set(`${sessionId}:${msg.request_id}`, patch)
  }
  sessionManager.observe({
    line(sessionId, line, from) {
      watchAgentSend(sessionId, line, from)
      watchSessionSettings(sessionId, line, from)
      const projectId = coordinators.get(sessionId)
      if (!projectId) return
      if (from === 'child') {
        tasks().fromChild(projectId, sessionId, line)
        if (settingRequests.size && line.includes('"type":"control_response"')) {
          const response = parseLine(line)?.response as { request_id?: unknown; subtype?: unknown } | undefined
          const requestId = typeof response?.request_id === 'string' ? response.request_id : ''
          const pending = settingRequests.get(requestId)
          if (pending) {
            settingRequests.delete(requestId)
            if (response!.subtype === 'success') projects().update(pending.projectId, pending.patch)
          }
        }
        return
      }
      tasks().fromClient(projectId, line)
      if (!line.includes('"type":"control_request"')) return
      const msg = parseLine(line)
      const request = (msg?.request ?? {}) as Record<string, unknown>
      const requestId = typeof msg?.request_id === 'string' ? msg.request_id : undefined
      if (!requestId) return
      if (request.subtype === 'set_model' && typeof request.model === 'string') {
        const model = request.model === 'default' || !MODEL.test(request.model) ? null : request.model
        settingRequests.set(requestId, { projectId, patch: { coordinator_model: model } })
      }
      const effort = (request.settings as { effortLevel?: unknown } | undefined)?.effortLevel
      if (request.subtype === 'apply_flag_settings' && typeof effort === 'string' && EFFORT.test(effort)) {
        settingRequests.set(requestId, { projectId, patch: { coordinator_effort: effort } })
      }
    },
    exit(sessionId) {
      sessionProviders.delete(sessionId)
      for (const key of [...agentSends.keys(), ...agentQueued.keys(), ...sessionSettingRequests.keys()]) {
        if (!key.startsWith(`${sessionId}:`)) continue
        agentSends.delete(key)
        agentQueued.delete(key)
        sessionSettingRequests.delete(key)
      }
      const projectId = coordinators.get(sessionId)
      if (!projectId) return
      coordinators.delete(sessionId)
      tasks().stopLive('exited', projectId)
    },
  })

  /**
   * The worker's transcript with the messages the user sent it while it ran,
   * each before the first message written after it was sent. They were sent
   * after the page had what came before, so the page's paging stays in step.
   */
  function withQueued(transcript: Record<string, unknown>[], queued: { id: number; ts: number; text: string }[]): Record<string, unknown>[] {
    if (!queued.length) return transcript
    // Once the worker reads one, its transcript has it too (a `queued_command`):
    // that copy goes, so the one shown since it was sent keeps its place.
    const copies = new Set<Record<string, unknown>>()
    for (const m of queued) {
      const copy = transcript.find(
        x =>
          !copies.has(x) &&
          x.type === 'user' &&
          (x.message as { content?: unknown } | undefined)?.content === m.text &&
          typeof x.timestamp === 'string' &&
          Date.parse(x.timestamp) >= m.ts,
      )
      if (copy) copies.add(copy)
    }
    const messages = copies.size ? transcript.filter(x => !copies.has(x)) : transcript
    const out: Record<string, unknown>[] = []
    let q = 0
    const user = (m: { id: number; ts: number; text: string }) => ({
      type: 'user',
      uuid: `queued-${m.id}`,
      timestamp: new Date(m.ts).toISOString(),
      parent_tool_use_id: null,
      isReplay: true,
      message: { role: 'user', content: m.text },
    })
    for (const message of messages) {
      const at = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN
      while (q < queued.length && Number.isFinite(at) && queued[q]!.ts <= at) out.push(user(queued[q++]!))
      out.push(message)
    }
    while (q < queued.length) out.push(user(queued[q++]!))
    return out
  }

  /** A task with its tokens read from the worker's transcript while its progress has none yet. */
  async function taskJson(task: Task): Promise<Task> {
    if (task.tokens || (task.state !== 'running' && task.state !== 'blocked')) return task
    const page = await readAgentTranscript(task.session_id, task.agent_id).catch(() => undefined)
    return page ? { ...task, tokens: transcriptTokens(page.messages) } : task
  }

  /**
   *   GET    /api/projects                  → projects, newest change first
   *   POST   /api/projects                  → create; 409 { needs_trust } for an untrusted folder
   *   PATCH  /api/projects/:id              → name, instructions, worker_model, worker_effort, permission_mode
   *   DELETE /api/projects/:id              → archive and stop its coordinator
   *   DELETE /api/projects/:id?purge=1      → also delete it; its sessions go back to their folders
   *   POST   /api/projects/:id/coordinator  → { session_id, work_dir }: start or resume the coordinator
   */
  async function handleProjects(req: Request, pathname: string): Promise<Response> {
    if (pathname === '/api/projects') {
      if (req.method === 'GET') {
        const counts = tasks().counts()
        return Response.json(projects().list().map(p => projectJson(p, counts)))
      }
      if (req.method !== 'POST') return errorResponse(405, 'Method not allowed')
      const parsed = createProjectBodySchema().safeParse(await readJson(req))
      if (!parsed.success) return errorResponse(400, 'Invalid request')
      const body = parsed.data
      const cwd = normalizeProjectDir(body.cwd)
      if (!cwd) return errorResponse(400, 'Not a directory')
      const refused = checkTrust(cwd, body.trust)
      if (refused) return refused
      const project = projects().create({
        name: body.name,
        cwd,
        instructions: body.instructions ?? '',
        worker_model: body.worker_model ?? null,
        worker_effort: body.worker_effort ?? null,
        permission_mode: body.permission_mode ?? 'default',
      })
      return Response.json(projectJson(project), { status: 201 })
    }
    const match = PROJECT_PATH.exec(pathname)
    const id = match && decodeURIComponent(match[1]!)
    if (!id || !SESSION_ID.test(id)) return errorResponse(400, 'Invalid project id')
    const project = projects().get(id)
    if (!project || project.archived_at !== null) return errorResponse(404, 'Project not found')
    if (match![2] === 'coordinator') {
      if (req.method !== 'POST') return errorResponse(405, 'Method not allowed')
      return openCoordinator(project)
    }
    if (match![2] === 'tasks') return handleTasks(req, project, match![3], match![4])
    if (req.method === 'PATCH') {
      const parsed = patchProjectBodySchema().safeParse(await readJson(req))
      if (!parsed.success) return errorResponse(400, 'Invalid request')
      const updated = projects().update(id, parsed.data)!
      const changed =
        updated.instructions !== project.instructions ||
        updated.worker_model !== project.worker_model ||
        updated.worker_effort !== project.worker_effort
      // A running coordinator picks up new instructions or task model by restarting with --resume.
      if (changed && updated.coordinator_session_id) {
        sessionManager.restart(updated.coordinator_session_id, {
          permissionMode: updated.permission_mode,
          ...(updated.coordinator_model && { model: updated.coordinator_model }),
          ...(updated.coordinator_effort && { effort: updated.coordinator_effort }),
          coordinator: coordinatorSpawn(updated),
        })
      }
      return Response.json(projectJson(updated))
    }
    if (req.method === 'DELETE') {
      if (new URL(req.url).searchParams.get('purge') === '1') projects().remove(id)
      else projects().archive(id)
      if (project.coordinator_session_id) await sessionManager.destroy(project.coordinator_session_id)
      return new Response(null, { status: 204 })
    }
    return errorResponse(405, 'Method not allowed')
  }

  /**
   *   GET  /api/projects/:id/tasks                       → the project's tasks, oldest first
   *   GET  /api/projects/:id/tasks/:task/transcript?after= → { messages, next }: the worker's
   *                                                          conversation from message `after` on
   *   POST /api/projects/:id/tasks/:task/review          → mark a finished task done
   */
  async function handleTasks(
    req: Request,
    project: Project,
    rawTaskId: string | undefined,
    action: string | undefined,
  ): Promise<Response> {
    if (rawTaskId === undefined) {
      if (req.method !== 'GET') return errorResponse(405, 'Method not allowed')
      return Response.json(await Promise.all(tasks().list(project.id).map(taskJson)))
    }
    const taskId = decodeURIComponent(rawTaskId)
    if (!AGENT_ID.test(taskId)) return errorResponse(400, 'Invalid task id')
    const task = tasks().get(project.id, taskId)
    if (!task) return errorResponse(404, 'Task not found')
    if (action === 'review') {
      if (req.method !== 'POST') return errorResponse(405, 'Method not allowed')
      return Response.json(tasks().review(project.id, taskId))
    }
    if (action === 'transcript' && req.method === 'GET') {
      const url = new URL(req.url)
      const page = await readAgentTranscript(task.session_id, task.agent_id)
      const messages = withQueued(page?.messages ?? [], tasks().queuedMessages(task.id))
      const after = intParam(url, 'after', 0, Number.MAX_SAFE_INTEGER)
      // A transcript shorter than what the page has was rewritten: send it whole.
      const from = after > messages.length ? 0 : after
      return Response.json({ messages: messages.slice(from), next: messages.length, reset: from !== after, tokens: transcriptTokens(messages) })
    }
    if (action === undefined && req.method === 'GET') return Response.json(await taskJson(task))
    return errorResponse(405, 'Method not allowed')
  }

  /** The running coordinator, else its transcript resumed, else a new one recorded on the project. */
  async function openCoordinator(project: Project): Promise<Response> {
    if (!isDirectory(project.cwd)) return errorResponse(400, 'Not a directory')
    const previous = project.coordinator_session_id
    const resume =
      previous && (sessionManager.get(previous) || (await resolveSessionFilePath(previous))) ? previous : undefined
    try {
      const session = sessionManager.create({
        cwd: project.cwd,
        permissionMode: project.permission_mode,
        ...(project.coordinator_model && { model: project.coordinator_model }),
        ...(project.coordinator_effort && { effort: project.coordinator_effort }),
        resume,
        channels: ext.readDefaultChannels(config.configDir ?? getClaudeConfigHomeDir()),
        coordinator: coordinatorSpawn(project),
      })
      coordinators.set(session.id, project.id)
      if (session.id !== previous) projects().update(project.id, { coordinator_session_id: session.id })
      // `fresh`: a new coordinator, with no transcript to load yet.
      return Response.json({ session_id: session.id, work_dir: session.workDir, ...(!resume && { fresh: true }) })
    } catch (err) {
      if (err instanceof SessionManagerError) return errorResponse(err.status, err.message)
      throw err
    }
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
    const { cwd, temporary, resume, permission_mode: permissionMode, model, effort, trust } = parsed.data
    let workDir = config.workspace
    if (temporary && !cwd && !resume) {
      mkdirSync(tempRoot, { recursive: true })
      workDir = mkdtempSync(join(tempRoot, 'chat-'))
    } else if (cwd) {
      if (!isAbsolute(cwd) || !isDirectory(cwd)) {
        return errorResponse(400, `Not a directory: ${cwd}`)
      }
      // A folder other than the workspace needs the trust the TUI asks for;
      // `claude -p` skips that dialog, so the page asks instead.
      if (!resume) {
        const refused = checkTrust(realpathSync(cwd), trust)
        if (refused) return refused
      }
      workDir = cwd
    } else {
      mkdirSync(workDir, { recursive: true })
    }
    try {
      const spawned = !resume || !sessionManager.get(resume)
      const session = sessionManager.create({
        cwd: workDir,
        permissionMode,
        model,
        effort,
        resume,
        channels: ext.readDefaultChannels(config.configDir ?? getClaudeConfigHomeDir()),
      })
      if (spawned) {
        sessionProviders.set(session.id, getAPIProvider())
        if (model || effort || permissionMode) {
          saveSessionSettings(session.id, {
            ...(model && { model }),
            ...(effort && { effort }),
            ...(permissionMode && { permission_mode: permissionMode }),
          })
        }
      }
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
    local: boolean,
  ): Promise<Response | undefined> {
    const { pathname } = url
    if (pathname === '/api/info' && req.method === 'GET') {
      return Response.json({
        workspace: config.workspace,
        preview_origins: previewOrigins,
        temp_root: tempRoot,
        home: homedir(),
        version: MACRO.VERSION,
        // The browser runs on this machine, so it may open files there.
        local,
      })
    }
    if (pathname === '/api/models' && req.method === 'GET') {
      await ensureModelStringsInitialized()
      // `model`: what a session started without a pick runs (the saved model, else the default),
      // read fresh because a session or the TUI may have saved another model since.
      resetSettingsCache()
      return Response.json({ models: getModelInfos(), model: getMainLoopModel() })
    }
    if (pathname === '/api/folder-files' && req.method === 'GET') {
      // The start page's `@` search, before a session exists: only folders a session may already use.
      const cwd = url.searchParams.get('cwd') ?? ''
      if (!isAbsolute(cwd) || !isDirectory(cwd)) return errorResponse(400, 'Not a directory')
      const folderTrust = config.folderTrust ?? { isTrusted: isPathTrusted, save: savePathTrusted }
      const dir = realpathSync(cwd)
      if (dir !== realOr(config.workspace) && !folderTrust.isTrusted(dir)) return Response.json({ files: [] })
      const files = await listWorkspaceFiles(dir, (url.searchParams.get('q') ?? '').slice(0, 200), {
        configDir: config.configDir ?? getClaudeConfigHomeDir(),
      })
      return Response.json({ files })
    }
    if (pathname === '/api/peers' && req.method === 'GET') {
      // Live Claude sessions with a messaging socket in this folder (what ListAgents/SendMessage see).
      const cwd = url.searchParams.get('cwd') ?? ''
      if (!isAbsolute(cwd)) return errorResponse(400, 'Not a directory')
      const dir = realOr(cwd)
      const peers = (await listAllLiveSessions()).filter(peer => peer.cwd && realOr(peer.cwd) === dir)
      return Response.json({
        peers: peers.map(peer => ({
          name: peer.name,
          ref: peer.ref,
          session_id: peer.sessionId,
          pid: peer.pid,
          kind: peer.kind ?? null,
          status: peer.status ?? null,
          address: formatPeerAddress(peer.messagingSocketPath),
        })),
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
    if (pathname === '/api/prompt-history' && req.method === 'GET') {
      const project = normalizeProjectDir(url.searchParams.get('cwd') ?? '')
      if (!project) return errorResponse(400, 'Invalid folder')
      const prompts: string[] = []
      for await (const entry of getTimestampedHistory(project.normalize('NFC'))) prompts.push(entry.display)
      return Response.json({ prompts })
    }
    if (pathname === '/api/prompt-history' && req.method === 'POST') {
      const parsed = promptHistoryBodySchema().safeParse(await readJson(req))
      const project = parsed.success ? normalizeProjectDir(parsed.data.cwd) : undefined
      if (!parsed.success || !project) return errorResponse(400, 'Invalid request')
      addToHistory(parsed.data.text, { project: project.normalize('NFC'), sessionId: parsed.data.session_id ?? '' })
      return Response.json({})
    }
    if (pathname === '/api/sidebar' && req.method === 'GET') {
      return Response.json(await loadSidebar(db(), intParam(url, 'limit', 200, 2000) || 200))
    }
    const metaMatch = SESSION_META_PATH.exec(pathname)
    if (metaMatch && req.method === 'PATCH') {
      const id = decodeURIComponent(metaMatch[1]!)
      if (!SESSION_ID.test(id)) return errorResponse(400, 'Invalid session id')
      const parsed = sessionMetaBodySchema().safeParse(await readJson(req))
      if (!parsed.success) return errorResponse(400, 'Invalid request')
      const projectId = parsed.data.project_id
      if (projectId && projects().get(projectId)?.archived_at !== null) return errorResponse(400, 'Unknown project')
      return Response.json(patchSessionMeta(db(), id, parsed.data))
    }
    const openMatch = OPEN_PATH.exec(pathname)
    if (openMatch && req.method === 'POST') {
      // The opener runs on this machine, so only a browser on it may ask.
      if (!local) return errorResponse(403, 'Only a browser on the machine running claude web can open local files')
      const id = decodeURIComponent(openMatch[1]!)
      if (!SESSION_ID.test(id)) return errorResponse(400, 'Invalid session id')
      const parsed = openBodySchema().safeParse((await readJson(req)) ?? {})
      if (!parsed.success) return errorResponse(400, 'Invalid request')
      const { path, reveal } = parsed.data
      const cwd = await sessionCwd(id)
      if (!cwd) return errorResponse(404, 'Session not found')
      let target = realOr(cwd)
      if (path && !isAbsolute(path)) return errorResponse(400, 'Not an absolute path')
      if (path && isDirectory(path)) {
        // A folder: the session's own or one inside it (a worktree).
        const dir = realOr(path)
        const rel = relative(target, dir)
        if (rel.startsWith('..') || isAbsolute(rel)) return errorResponse(403, 'Only the session folder can be opened')
        target = dir
      } else if (path) {
        // A file the session may show in its preview, or the folder holding it.
        const file = await sessionFile(id, path)
        if (!file) return errorResponse(404, 'File not found')
        target = reveal ? dirname(file) : file
      }
      if (!path && !isDirectory(target)) return errorResponse(404, 'Folder not found')
      const error = await (config.openLocal ?? openLocal)(target)
      return error ? errorResponse(500, error) : new Response(null, { status: 204 })
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
      if (!page) return errorResponse(404, 'Session not found')
      // What the session last ran with, for a page that opens it while its process is gone;
      // picks made under another provider (an account switch since) do not apply.
      const { provider, ...settings } = (before === undefined && readSessionSettings(db(), id)) || {}
      return Response.json(provider === getAPIProvider() ? { ...page, settings } : page)
    }
    const agentMatch = AGENT_MESSAGES_PATH.exec(pathname)
    if (agentMatch && req.method === 'GET') {
      const id = decodeURIComponent(agentMatch[1]!)
      const agentId = decodeURIComponent(agentMatch[2]!)
      if (!SESSION_ID.test(id) || !AGENT_ID.test(agentId)) {
        return errorResponse(400, 'Invalid id')
      }
      const page = await readAgentTranscript(id, agentId)
      return page
        ? Response.json({ messages: withQueued(page.messages, agentQueued.get(`${id}:${agentId}`) ?? []) })
        : errorResponse(404, 'Agent not found')
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
    const snippetMatch = SNIPPET_PATH.exec(pathname)
    if (snippetMatch && req.method === 'GET') {
      const id = decodeURIComponent(snippetMatch[1]!)
      if (!SESSION_ID.test(id)) return errorResponse(400, 'Invalid session id')
      const snippet = await readSnippet(id)
      return snippet === undefined ? errorResponse(404, 'Session not found') : Response.json({ snippet })
    }
    // `{ message_id }` → `{ session_id }`: a new session with the conversation up to that reply.
    const forkMatch = FORK_PATH.exec(pathname)
    if (forkMatch && req.method === 'POST') {
      const id = decodeURIComponent(forkMatch[1]!)
      const body = (await readJson(req)) as { message_id?: unknown } | undefined
      const messageId = body?.message_id
      if (!SESSION_ID.test(id) || typeof messageId !== 'string' || !/^[\w-]{1,128}$/.test(messageId)) {
        return errorResponse(400, 'Invalid id')
      }
      const forkId = await forkSession(id, messageId)
      return forkId ? Response.json({ session_id: forkId }) : errorResponse(404, 'Message not found')
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
    if (pathname === '/api/projects' || pathname.startsWith('/api/projects/')) {
      return handleProjects(req, pathname)
    }
    if (pathname.startsWith('/api/ext/')) {
      return handleExtApi(req, url, config.configDir ?? getClaudeConfigHomeDir())
    }
    if (
      pathname.startsWith('/api/account') ||
      pathname === '/api/settings' ||
      pathname === '/api/usage'
    ) {
      const res = await handleAccount(req, url)
      if (res) return res
    }
    const filesMatch = FILES_PATH.exec(pathname)
    if (filesMatch) {
      return handleFiles(req, url, decodeURIComponent(filesMatch[1]!), filesMatch[2])
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
      const id = decodeURIComponent(sessionMatch[1]!)
      if (url.searchParams.get('transcript') === '1') {
        if (!SESSION_ID.test(id)) return errorResponse(400, 'Invalid session id')
        await sessionManager.destroy(id)
        if (!(await deleteTranscript(id))) return errorResponse(404, 'Session not found')
        deleteSessionMeta(db(), id)
        return new Response(null, { status: 204 })
      }
      const found = await sessionManager.destroy(id)
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
          let res: Response | undefined
          try {
            res = await handleApi(req, url, srv, addressKind(peer!) === 'loopback')
          } catch (err) {
            // A malformed %-escape in a path segment.
            if (err instanceof URIError) return withHeaders(errorResponse(400, 'Malformed URL'))
            throw err
          }
          return res && withHeaders(res)
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return withHeaders(errorResponse(405, 'Method not allowed'))
        }
        if (pathname === MODS_FRAME_PATH) {
          const res = new Response(MODS_FRAME_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
          for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.headers.set(key, value)
          res.headers.set('Content-Security-Policy', MODS_FRAME_CSP)
          return res
        }
        if (pathname === MCP_APP_FRAME_PATH) {
          const res = new Response(MCP_APP_FRAME_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
          for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.headers.set(key, value)
          res.headers.set('Content-Security-Policy', MCP_APP_FRAME_CSP)
          return res
        }
        const asset = assets.get(pathname) ?? assets.get('/index.html')
        if (!asset) return withHeaders(errorResponse(404, 'Not found'))
        return withHeaders(
          new Response(asset.body as BodyInit, { headers: { 'Content-Type': asset.type } }),
        )
      },
      // Without this, Bun answers an uncaught error with its debug page (source lines and paths).
      error(err) {
        logger.warn(`request failed: ${err.message}`)
        return withHeaders(errorResponse(500, 'Internal error'))
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
      // Before the coordinators go: their workers stop because the server does.
      taskStore?.stopLive('restart')
      for (const server of servers) void server.stop(force)
    },
  }
}
