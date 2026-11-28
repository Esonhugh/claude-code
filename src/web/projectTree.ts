import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { DENIED_NAME, SKIPPED_DIRS } from './files.js'

const PAGE_SIZE = 200
const SCAN_LIMIT = 2_000
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const DARWIN_CLOEXEC = 0x01000000
const BROAD_ROOTS = ['/Applications', '/Library', '/System', '/Users', '/Volumes', '/opt', '/private', '/private/tmp', '/private/var', '/usr']
const SYSTEM_ROOTS = ['/System', '/dev', '/private/etc', '/private/var/db']
const native = {
  openat: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
  fdopendir: { args: ['i32'], returns: 'ptr' },
  readdir: { args: ['ptr'], returns: 'ptr' },
  closedir: { args: ['ptr'], returns: 'i32' },
  __error: { args: [], returns: 'ptr' },
} as const

let directoryApi: {
  ffi: typeof import('bun:ffi')
  library: import('bun:ffi').Library<typeof native>
} | null | undefined

// Bun's fs.opendir currently materializes the directory on its first read.
// Use the verified 64-bit Darwin ABI; other runtimes must not fall back to an
// unbounded/path-based listing. The library lives for the server lifetime.
function getDirectoryApi() {
  if (directoryApi !== undefined) return directoryApi
  directoryApi = null
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || typeof Bun === 'undefined') return directoryApi
  try {
    const ffi = createRequire(import.meta.url)('bun:ffi') as typeof import('bun:ffi')
    directoryApi = { ffi, library: ffi.dlopen('/usr/lib/libSystem.B.dylib', native) }
  } catch {
    // Leave Files unavailable if the installed runtime cannot load the ABI.
  }
  return directoryApi
}

export function projectTreeSupported(): boolean {
  return getDirectoryApi() !== null
}

function validName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !/[\\/:\p{C}]/u.test(name) &&
    !/[. ]$/u.test(name) && Buffer.byteLength(name) <= 255
}

function hiddenName(name: string): boolean {
  return name.startsWith('.') || DENIED_NAME.test(name) || SKIPPED_DIRS.has(name.toLowerCase()) ||
    /^(credentials|secrets)$/i.test(name)
}

export function projectTreePath(dir: string): string[] | undefined {
  if (!dir) return []
  if (Buffer.byteLength(dir) > 2048) return undefined
  const parts = dir.split('/')
  return parts.length <= 24 && parts.every(validName) ? parts : undefined
}

function inside(path: string, parent: string): boolean {
  // Conservative for case-insensitive and normalization-insensitive volumes.
  return pathKey(path) === pathKey(parent) || pathKey(path).startsWith(`${pathKey(parent).replace(/\/$/, '')}/`)
}

const pathKey = (value: string) => value.normalize('NFD').toLowerCase()

export function webWorkspaceOptions(configDir: string, override?: string) {
  return { workspace: override ?? join(configDir, 'web', 'workspace'), usesDefaultWorkspace: override === undefined }
}

export type TreeRoot = { path: string; dev: bigint; ino: bigint }

export function identifyTreeRoot(path: string): TreeRoot | undefined {
  try {
    const st = lstatSync(path, { bigint: true })
    if (st.isDirectory()) return { path, dev: st.dev, ino: st.ino }
  } catch {
    // Vanished or inaccessible directories do not authorize a tree.
  }
}

export function defaultTreeWorkspace(configDir: string, workspace: string): TreeRoot | undefined {
  try {
    const expected = join(realpathSync(configDir), 'web', 'workspace')
    if (realpathSync(workspace) === expected) return identifyTreeRoot(expected)
  } catch {
    // Never grant the exception to a workspace redirected to another directory.
  }
}

const matchesRoot = (st: { dev: bigint; ino: bigint }, root: TreeRoot) => st.dev === root.dev && st.ino === root.ino

type Entry = { name: string; type: 'directory' | 'file' }

export async function listProjectTree(
  root: string,
  parts: string[],
  policy: { configDir: string; uploadsDir: string; defaultWorkspace?: TreeRoot; sessionRoot?: TreeRoot },
  signal: AbortSignal,
): Promise<{ entries: Entry[]; truncated: boolean } | undefined> {
  const api = getDirectoryApi()
  if (!api || !isAbsolute(root) || resolve(root) !== root || inside(homedir(), root) ||
    BROAD_ROOTS.some(path => pathKey(path) === pathKey(root))) return undefined
  const rootParts = root.slice(1).split('/')
  const managed = policy.defaultWorkspace
  const managedDepth = managed && (root === managed.path || root.startsWith(`${managed.path}/`))
    ? managed.path.slice(1).split('/').length : 0
  // The built-in workspace permits only the config directory's own hidden name,
  // not a hidden parent above it or hidden project roots inside it.
  const hiddenRoot = rootParts.some((name, i) => {
    if (managedDepth) return hiddenName(name) && i !== managedDepth - 3
    // An explicitly admitted worktree outside private config may live here.
    return hiddenName(name) && !(name === '.claude' && rootParts[i + 1] === 'worktrees')
  })
  if (hiddenRoot || parts.some(hiddenName)) return undefined

  // Also protect the canonical paths if config or uploads were configured via links.
  const blocked = [resolve(policy.uploadsDir), ...SYSTEM_ROOTS]
  if (!managedDepth) blocked.push(resolve(policy.configDir))
  const canonical = (path: string) => realpath(path).catch(() => undefined)
  const [home, temp, ...resolved] = await Promise.all([canonical(homedir()), canonical(tmpdir()), ...blocked.map(canonical)])
  if ((home && inside(home, root)) || (temp && pathKey(temp) === pathKey(root))) return undefined
  for (const path of resolved) {
    if (path) blocked.push(path)
  }
  const denied = (path: string) => blocked.some(parent => inside(path, parent))
  const directoryPath = join(root, ...parts)
  if (denied(root) || denied(directoryPath)) return undefined
  signal.throwIfAborted()
  const before = await lstat(root, { bigint: true })
  if (!before.isDirectory() || (policy.sessionRoot && !matchesRoot(before, policy.sessionRoot))) return undefined
  const { ffi, library: { symbols } } = api
  let fd = openSync('/', DIRECTORY)
  let dir: ReturnType<typeof symbols.fdopendir> = null
  try {
    // Walk from a pinned filesystem root, one component at a time. O_NOFOLLOW
    // therefore applies to every component, including the registered root.
    for (const [i, name] of [...rootParts, ...parts].entries()) {
      const next = symbols.openat(fd, Buffer.from(`${name}\0`), DIRECTORY | DARWIN_CLOEXEC)
      if (next < 0) return undefined
      closeSync(fd)
      fd = next
      if (managed && i === managedDepth - 1 && !matchesRoot(fstatSync(fd, { bigint: true }), managed)) return undefined
      if (i >= rootParts.length - 1) {
        const st = fstatSync(fd, { bigint: true })
        if (st.dev !== before.dev || (i === rootParts.length - 1 && st.ino !== before.ino)) return undefined
      }
    }
    const opened = fstatSync(fd, { bigint: true })
    dir = symbols.fdopendir(fd)
    if (!dir) throw new Error('Cannot open directory stream')
    fd = -1 // fdopendir now owns it.
    const entries: Entry[] = []
    let truncated = true
    for (let scanned = 0; scanned < SCAN_LIMIT; scanned++) {
      if (scanned > 0 && scanned % 64 === 0) await new Promise<void>(done => setImmediate(done))
      signal.throwIfAborted()
      const errno = symbols.__error()!
      new Int32Array(ffi.toArrayBuffer(errno, 0, 4))[0] = 0
      const entry = symbols.readdir(dir)
      if (!entry) {
        if (ffi.read.i32(errno) !== 0) throw new Error('Cannot read directory stream')
        truncated = false
        break
      }
      // Darwin sys/dirent.h: d_reclen, d_namlen, d_type and d_name.
      const length = ffi.read.u16(entry, 18)
      const type = ffi.read.u8(entry, 20)
      if ((type !== 4 && type !== 8) || !length || length > 255 || 21 + length >= ffi.read.u16(entry, 16)) continue
      const name = Buffer.from(ffi.toArrayBuffer(entry, 21, length)).toString('utf8')
      if (name.includes('\ufffd') || !validName(name) || hiddenName(name) || denied(join(directoryPath, name))) continue
      if (entries.length === PAGE_SIZE) break
      entries.push({ name, type: type === 4 ? 'directory' : 'file' })
    }
    signal.throwIfAborted()
    // Drop results if the registered root or the requested directory was visibly
    // moved or replaced while we were reading; no snapshot of mutable contents.
    const after = await lstat(root, { bigint: true })
    const current = parts.length ? await lstat(directoryPath, { bigint: true }) : after
    if (managed && managedDepth && !matchesRoot(await lstat(managed.path, { bigint: true }), managed)) return undefined
    if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino ||
      !current.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino) return undefined
    signal.throwIfAborted()
    entries.sort((a, b) => a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === 'directory' ? -1 : 1)
    return { entries, truncated }
  } finally {
    if (dir) symbols.closedir(dir)
    else if (fd >= 0) closeSync(fd)
  }
}
