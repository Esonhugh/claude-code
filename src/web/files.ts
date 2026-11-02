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
const DENIED_NAME = /^(\.credentials\.json|\.env(\..*)?|.*\.(key|pem|p12|pfx))$/i

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
  const log = await loadTranscriptFromFile(found.filePath)
  const files = new Set<string>()
  let cwd: string | undefined
  for (const m of log.messages as unknown as Record<string, unknown>[]) {
    cwd ??= typeof m.cwd === 'string' ? m.cwd : undefined
    const content = (m.message as { content?: unknown } | undefined)?.content
    if (m.type !== 'assistant' || !Array.isArray(content)) continue
    for (const block of content as { type?: string; input?: Record<string, unknown> }[]) {
      if (block.type !== 'tool_use' || !block.input) continue
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
 * claude config dir except `claude web`'s own folder, never a credential.
 */
export async function resolveAllowedFile(
  path: string,
  scope: { roots: string[]; files: string[]; configDir: string },
): Promise<string | undefined> {
  const target = await real(path)
  if (!target || DENIED_NAME.test(basename(target))) return undefined
  const configDir = await real(scope.configDir)
  const webDir = configDir && (await real(join(configDir, 'web')))
  if (configDir && within(target, configDir) && !(webDir && within(target, webDir))) {
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
