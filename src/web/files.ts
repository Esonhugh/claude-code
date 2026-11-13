import { createHash } from 'crypto'
import { mkdir, readdir, realpath, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, extname, join, sep } from 'path'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { loadTranscriptFromFile } from '../utils/sessionStorage.js'
import { resolveSessionFilePath } from '../utils/sessionStoragePortable.js'
import { which } from '../utils/which.js'

export type UploadLimits = { fileBytes: number; sessionBytes: number }

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  fileBytes: 50 * 1024 * 1024,
  sessionBytes: 500 * 1024 * 1024,
}

// Credentials never leave the machine through the file API, wherever they are.
const DENIED_NAME =
  /^(\.credentials\.json|\.claude\.json(\..*)?|\.env(\..*)?|\.netrc|\.git-credentials|\.npmrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)|.*\.(key|pem|p12|pfx))$/i

/** Keeps the last path segment and drops control characters. */
export function safeUploadName(name: string): string {
  const base = (name.split(/[\\/]/).at(-1) ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200)
  return base && base !== '.' && base !== '..' ? base : 'upload'
}

async function dirBytes(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[])
  const sizes = await Promise.all(
    names.map(n => stat(join(dir, n)).then(s => s.size, () => 0)),
  )
  return sizes.reduce((a, b) => a + b, 0)
}

async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? name : `${stem} (${i})${ext}`
    try {
      await stat(join(dir, candidate))
    } catch {
      return candidate
    }
  }
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Writes an upload to `<uploadsDir>/<sessionId>/<name>` within the limits. */
export async function saveUpload(
  uploadsDir: string,
  sessionId: string,
  name: string,
  body: ArrayBuffer,
  limits: UploadLimits,
): Promise<{ path: string; name: string; size: number }> {
  if (body.byteLength > limits.fileBytes) {
    throw new UploadError(413, 'File is larger than the upload limit')
  }
  const dir = join(uploadsDir, sessionId)
  await mkdir(dir, { recursive: true })
  if ((await dirBytes(dir)) + body.byteLength > limits.sessionBytes) {
    throw new UploadError(413, 'Uploads for this session exceed the limit')
  }
  const fileName = await freeName(dir, safeUploadName(name))
  const path = join(dir, fileName)
  await writeFile(path, new Uint8Array(body), { flag: 'wx' })
  return { path, name: fileName, size: body.byteLength }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

async function real(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

/** Working directory and the files its tools read or wrote, from the transcript. */
export async function transcriptFileScope(
  sessionId: string,
): Promise<{ cwd?: string; files: string[] }> {
  const found = await resolveSessionFilePath(sessionId)
  if (!found) return { files: [] }
  const log = await loadTranscriptFromFile(found.filePath).catch((err: unknown) => {
    // A new session's transcript can hold metadata before its first message is flushed.
    if (err instanceof Error && /^No (messages|valid conversation chain) found/.test(err.message)) return undefined
    throw err
  })
  if (!log) return { cwd: found.projectPath, files: [] }
  const files = new Set<string>()
  let cwd: string | undefined
  type Block = { type?: string; id?: string; tool_use_id?: string; is_error?: boolean; input?: Record<string, unknown> }
  const contentOf = (m: Record<string, unknown>) => {
    const content = (m.message as { content?: unknown } | undefined)?.content
    return Array.isArray(content) ? (content as Block[]) : []
  }
  const messages = log.messages as unknown as Record<string, unknown>[]
  // Only calls that ran: a call the user refused (or that failed) must not open its file here.
  const ran = new Set(
    messages.flatMap(m => contentOf(m).filter(b => b.type === 'tool_result' && b.is_error !== true).map(b => b.tool_use_id)),
  )
  for (const m of messages) {
    cwd ??= typeof m.cwd === 'string' ? m.cwd : undefined
    if (m.type !== 'assistant') continue
    for (const block of contentOf(m)) {
      if (block.type !== 'tool_use' || !block.input || !ran.has(block.id)) continue
      for (const key of ['file_path', 'notebook_path']) {
        const value = block.input[key]
        if (typeof value === 'string') files.add(value)
      }
    }
  }
  return { cwd: cwd ?? found.projectPath, files: [...files] }
}

/**
 * Resolves `path` to a real file a session may show: inside one of `roots`
 * (after symlinks are resolved) or one of `files` exactly, never inside the
 * claude config dir except `claude web`'s uploads and temporary chats, never a credential.
 */
export async function resolveAllowedFile(
  path: string,
  scope: { roots: string[]; files: string[]; configDir: string },
): Promise<string | undefined> {
  const target = await real(path)
  if (!target || DENIED_NAME.test(basename(target))) return undefined
  const configDir = await real(scope.configDir)
  // Not the rest of `web/`: server.json there holds the key that signs the sign-in cookie.
  const shared = configDir
    ? await Promise.all(['uploads', 'temp'].map(name => real(join(configDir, 'web', name))))
    : []
  if (configDir && within(target, configDir) && !shared.some(dir => dir && within(target, dir))) {
    return undefined
  }
  const info = await stat(target).catch(() => undefined)
  if (!info?.isFile()) return undefined
  for (const root of scope.roots) {
    const r = await real(root)
    if (r && within(target, r)) return target
  }
  for (const file of scope.files) {
    if ((await real(file)) === target) return target
  }
  return undefined
}

// Folders `@` completion never walks into: dependencies, build output, VCS.
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '__pycache__', 'vendor'])

/**
 * Files under `root` whose relative path contains `query` (case-insensitive),
 * for `@` completion: names starting with it first, then shorter paths.
 * Hidden entries, credentials and the claude config dir are left out, the
 * same rules `resolveAllowedFile` applies; the walk stops after `scanLimit` entries.
 */
export async function listWorkspaceFiles(
  root: string,
  query: string,
  options: { configDir: string; limit?: number; scanLimit?: number },
): Promise<string[]> {
  const base = await real(root)
  if (!base) return []
  const configDir = await real(options.configDir)
  const needle = query.toLowerCase()
  const limit = options.limit ?? 30
  let budget = options.scanLimit ?? 20_000
  const hits: string[] = []
  const queue = ['']
  while (queue.length && budget > 0) {
    const rel = queue.shift()!
    const dir = join(base, rel)
    if (configDir && within(dir, configDir)) continue
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (--budget <= 0) break
      if (e.name.startsWith('.')) continue
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) queue.push(path)
      } else if (e.isFile() && !DENIED_NAME.test(e.name) && path.toLowerCase().includes(needle)) {
        hits.push(path)
      }
    }
  }
  const starts = (p: string) => (basename(p).toLowerCase().startsWith(needle) ? 0 : 1)
  return hits
    .sort((a, b) => starts(a) - starts(b) || a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, limit)
}

const CONVERTIBLE = new Set(['.ppt', '.pptx', '.odp', '.doc', '.rtf', '.odt', '.xls', '.ods'])

/**
 * Converts an Office document to PDF with a local LibreOffice, cached by
 * path and mtime. Returns undefined when `soffice` is not installed.
 */
export async function convertToPdf(path: string): Promise<string | undefined> {
  if (!CONVERTIBLE.has(extname(path).toLowerCase())) return undefined
  const soffice = (await which('soffice')) ?? (await which('libreoffice'))
  if (!soffice) return undefined
  const info = await stat(path)
  const key = createHash('sha256')
    .update(`${path}\0${info.mtimeMs}\0${info.size}`)
    .digest('hex')
    .slice(0, 32)
  const outDir = join(tmpdir(), 'claude-web-convert', key)
  const out = join(outDir, basename(path, extname(path)) + '.pdf')
  if (await real(out)) return out
  await mkdir(outDir, { recursive: true })
  const { code } = await execFileNoThrowWithCwd(
    soffice,
    ['--headless', '--convert-to', 'pdf', '--outdir', outDir, path],
    { timeout: 120_000, cwd: outDir },
  )
  return code === 0 && (await real(out)) ? out : undefined
}
