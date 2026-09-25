import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { StringDecoder } from 'node:string_decoder'
import { lock } from '../../utils/lockfile.js'
import { getPluginDataDir } from '../../utils/plugins/pluginDirectories.js'
import { atomicWriteToZipCache } from '../../utils/plugins/zipCache.js'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import treeKill from 'tree-kill'
import { getInitialSettings, getSettingsForSource } from '../../utils/settings/settings.js'
import { getAdditionalDirectoriesForClaudeMd } from '../../bootstrap/state.js'
import { isBareMode, isEnvTruthy } from '../../utils/envUtils.js'

export type ModCredential = { kind: 'bearer' | 'api-key'; secret: string }
export type ModAuthorization = { handle: string; kind: ModCredential['kind'] } | null
export type ModHttpInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  auth?: string
  socketPath?: string
}
export type ModHttpResponse = { status: number; ok: boolean; headers: Record<string, string>; text: string }
export type ModHttpServices = {
  firstPartyCredential?(): Promise<ModCredential | null>
  httpFetch?(url: string, init: RequestInit): Promise<Response>
}

export type SettingsReadArgs = {
  source?: 'user' | 'project' | 'local' | 'flag' | 'policy'
}

export type FsBytes = { base64: string }
export type FsReadOptions = { as: 'text' | 'bytes' }

export type FsAncestorsRequest = {
  names: readonly string[]
  of?: string
  below?: string
}
export type FsAncestorPart = { path: string; content: string }
export type FsAncestor = {
  dir: string
  name: string
  content: string
  parts: readonly FsAncestorPart[]
}

export type FsEntry = {
  name: string
  kind: 'file' | 'dir' | 'other'
  size: number
  isLink: boolean
}
export type FsStatOptions = { resolve: boolean }
export type FsStat = {
  kind: FsEntry['kind']
  size: number
  mtimeMs: number
  isLink: boolean
  realPath?: string
}

function kind(entry: {
  isFile(): boolean
  isDirectory(): boolean
}): FsEntry['kind'] {
  return entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other'
}

function checkedString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new TypeError(`${label} must be a string without NUL`)
  }
}

export type ProcessRunInit = {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}
export type ProcessRunResult = {
  exitCode: number
  stdout: string
  stderr: string
}

const MAX_BYTES = 4 * 1024 * 1024
const MAX_STORE_CHARACTERS = 4 * 1024 * 1024

async function readBytes(path: string, signal: AbortSignal, maxBytes = MAX_BYTES): Promise<Buffer> {
  signal.throwIfAborted()
  // A plugin can name a FIFO: opening it must not wait for a writer.
  const file = await open(path, process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      signal.throwIfAborted()
      const chunk = Buffer.allocUnsafe(64 * 1024)
      let bytesRead: number
      try {
        bytesRead = (await file.read(chunk, 0, chunk.length, null)).bytesRead
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') break
        throw error
      }
      signal.throwIfAborted()
      if (bytesRead === 0) break
      size += bytesRead
      if (size > maxBytes) throw new RangeError(`Read exceeds ${maxBytes / (1024 * 1024)} MiB`)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks)
  } finally {
    await file.close()
  }
}

async function readText(path: string, signal: AbortSignal, maxBytes = MAX_BYTES): Promise<string> {
  return (await readBytes(path, signal, maxBytes)).toString('utf8')
}

export function createModHostOperations({
  cwd,
  root = cwd,
  storageId,
  signal,
  sessionId = () => undefined,
  firstPartyCredential = async () => null,
  httpFetch = (url, init) => fetch(url, init),
}: {
  cwd: () => string
  root?: () => string
  storageId: string
  signal: AbortSignal
  sessionId?: () => string | undefined
} & ModHttpServices) {
  if (typeof storageId !== 'string' || !storageId)
    throw new TypeError('storageId must be a nonempty canonical identity')
  const activationSignal = signal
  const authorizations = new Map<string, { session: string; credential: ModCredential }>()
  signal.addEventListener('abort', () => authorizations.clear(), { once: true })
  const storeName = `mod-store-${createHash('sha256').update(storageId).digest('hex')}.json`
  const storePath = () => join(getPluginDataDir(storageId), storeName)

  async function readStore(path: string): Promise<Map<string, unknown>> {
    let text: string
    try {
      // Allow UTF-8 expansion and the entries-array overhead of the local format.
      text = await readText(path, signal, 4 * MAX_STORE_CHARACTERS)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      throw error
    }
    const entries: unknown = JSON.parse(text)
    if (
      !Array.isArray(entries) ||
      entries.some(
        (entry) =>
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string',
      )
    ) {
      throw new TypeError('Invalid mod store: expected JSON key/value entries')
    }
    const result = new Map<string, unknown>(entries)
    if (result.size !== entries.length)
      throw new TypeError('Invalid mod store: duplicate keys')
    return result
  }

  async function updateStore(
    change: (data: Map<string, unknown>) => boolean,
  ): Promise<void> {
    signal.throwIfAborted()
    const path = storePath()
    let release: (() => Promise<void>) | undefined
    const deadline = Date.now() + 30_000
    // Hold the lock across read, mutation and atomic replacement, not only the write.
    while (!release) {
      signal.throwIfAborted()
      try {
        release = await lock(path, { realpath: false, retries: 0 })
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ELOCKED' ||
          Date.now() >= deadline
        )
          throw error
        await delay(10, undefined, { signal })
      }
    }
    try {
      signal.throwIfAborted()
      const data = await readStore(path)
      if (!change(data)) return
      if (JSON.stringify(Object.fromEntries(data)).length > MAX_STORE_CHARACTERS)
        throw new RangeError('Store exceeds 4194304 characters')
      signal.throwIfAborted()
      await atomicWriteToZipCache(path, JSON.stringify([...data]))
    } finally {
      await release()
    }
  }

  function resolvePath(path: string): string {
    signal.throwIfAborted()
    if (typeof path !== 'string' || path === '')
      throw new TypeError('path must be a nonempty string')
    if (/^[\\/]{2}/.test(path))
      throw new TypeError('Network paths are not supported')
    return resolve(cwd(), path)
  }

  async function read(path: string, options?: { as: 'text' }, signal?: AbortSignal): Promise<string>
  async function read(path: string, options: { as: 'bytes' }, signal?: AbortSignal): Promise<FsBytes>
  async function read(path: string, options: FsReadOptions, signal?: AbortSignal): Promise<string | FsBytes>
  async function read(
    path: string,
    options: FsReadOptions = { as: 'text' },
    signal: AbortSignal = activationSignal,
  ): Promise<string | FsBytes> {
    signal.throwIfAborted()
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        (options.as !== 'text' && options.as !== 'bytes'))
      throw new TypeError('fs.read options.as must be text or bytes')
    const bytes = await readBytes(resolvePath(path), signal)
    return options.as === 'bytes' ? { base64: bytes.toString('base64') } : bytes.toString('utf8')
  }

  return {
    session: {
      async authorize(): Promise<ModAuthorization> {
        signal.throwIfAborted()
        const session = sessionId()
        if (!session) return null
        const credential = await firstPartyCredential()
        signal.throwIfAborted()
        if (session !== sessionId()) throw new Error('Session authorization expired')
        if (!credential) return null
        if (!['bearer', 'api-key'].includes(credential.kind) || typeof credential.secret !== 'string' || !credential.secret || /[\r\n\0]/.test(credential.secret))
          throw new TypeError('Invalid host credential')
        const handle = randomUUID()
        authorizations.set(handle, { session, credential: { ...credential } })
        return { handle, kind: credential.kind }
      },
    },
    http: {
      async fetch(url: string, init: ModHttpInit = {}, requestSignal = activationSignal): Promise<ModHttpResponse> {
        signal.throwIfAborted()
        const target = new URL(url)
        const headers = new Headers(init.headers)
        if (init.auth !== undefined) {
          const authorization = authorizations.get(init.auth)
          if (!authorization || authorization.session !== sessionId()) throw new Error('Invalid or expired session authorization')
          if (target.protocol !== 'https:' || target.hostname !== 'api.anthropic.com' || target.port || init.socketPath)
            throw new Error('Session authorization requires a first-party HTTPS host')
          headers.delete('authorization')
          headers.delete('x-api-key')
          const { kind, secret } = authorization.credential
          headers.set(kind === 'bearer' ? 'authorization' : 'x-api-key', kind === 'bearer' ? `Bearer ${secret}` : secret)
        }
        const response = await httpFetch(target.href, {
          method: init.method, headers, body: init.body, redirect: 'manual', signal: requestSignal,
        })
        const responseHeaders: Record<string, string> = {}
        response.headers.forEach((value, name) => { responseHeaders[name] = value })
        const result = { status: response.status, ok: response.ok, headers: responseHeaders, text: await response.text() }
        signal.throwIfAborted()
        return result
      },
    },
    env: {
      async get(name: string): Promise<string | undefined> {
        signal.throwIfAborted()
        checkedString(name, 'environment name')
        if (!name || name.includes('=')) throw new TypeError('Invalid environment name')
        return process.env[name]
      },
      async set(name: string, value: string | undefined): Promise<void> {
        signal.throwIfAborted()
        checkedString(name, 'environment name')
        if (!name || name.includes('=')) throw new TypeError('Invalid environment name')
        if (value === undefined) delete process.env[name]
        else {
          checkedString(value, 'environment value')
          process.env[name] = value
        }
      },
    },
    settings: {
      async read(args: SettingsReadArgs = {}): Promise<Readonly<Record<string, unknown>>> {
        signal.throwIfAborted()
        if (!args || typeof args !== 'object' || Array.isArray(args))
          throw new TypeError('settings.read args must be an object')
        if (args.source !== undefined && !['user', 'project', 'local', 'flag', 'policy'].includes(args.source))
          throw new TypeError('Invalid settings.read source')
        // Use the engine's accepted caches, including retained files pending review.
        // Do not reset caches or independently read settings from disk here.
        const settings = args.source === undefined
          ? getInitialSettings()
          : getSettingsForSource(`${args.source}Settings`) ?? {}
        return structuredClone(settings)
      },
    },
    store: {
      async get(key: string): Promise<unknown> {
        signal.throwIfAborted()
        if (typeof key !== 'string' || key.length === 0 || key.length > 256)
          throw new TypeError('key must be a nonempty string of at most 256 characters')
        return (await readStore(storePath())).get(key)
      },
      async keys(): Promise<string[]> {
        signal.throwIfAborted()
        return [...(await readStore(storePath())).keys()]
      },
      async set(key: string, value: unknown): Promise<void> {
        if (typeof key !== 'string' || key.length === 0 || key.length > 256)
          throw new TypeError('key must be a nonempty string of at most 256 characters')
        const text = JSON.stringify(value)
        if (text === undefined) throw new TypeError('value must be JSON data')
        const stored: unknown = JSON.parse(text)
        await updateStore((data) => {
          data.set(key, stored)
          return true
        })
      },
      async delete(key: string): Promise<void> {
        if (typeof key !== 'string' || key.length === 0 || key.length > 256)
          throw new TypeError('key must be a nonempty string of at most 256 characters')
        await updateStore(data => data.delete(key))
      },
    },
    process: {
      async run(
        argv: readonly string[],
        init: ProcessRunInit = {},
        signal: AbortSignal = activationSignal,
      ): Promise<ProcessRunResult> {
        signal.throwIfAborted()
        if (!Array.isArray(argv) || !argv.length)
          throw new TypeError('argv must be a nonempty string array')
        for (const arg of argv) checkedString(arg, 'argv entry')
        if (!argv[0]) throw new TypeError('argv executable must not be empty')
        if (!init || typeof init !== 'object' || Array.isArray(init))
          throw new TypeError('init must be an object')
        if (init.cwd !== undefined) checkedString(init.cwd, 'cwd')
        if (init.stdin !== undefined && typeof init.stdin !== 'string')
          throw new TypeError('stdin must be a string')
        if (init.env !== undefined) {
          if (
            !init.env ||
            typeof init.env !== 'object' ||
            Array.isArray(init.env)
          )
            throw new TypeError('env must be a string record')
          for (const [key, value] of Object.entries(init.env)) {
            checkedString(key, 'env key')
            if (!key || key.includes('='))
              throw new TypeError('Invalid env key')
            checkedString(value, 'env value')
          }
        }
        const timeoutMs = init.timeoutMs === undefined ? 30_000 : init.timeoutMs
        if (
          typeof timeoutMs !== 'number' ||
          !Number.isInteger(timeoutMs) ||
          timeoutMs < 1 ||
          timeoutMs > 600_000
        ) {
          throw new RangeError('timeoutMs must be an integer between 1 and 600000')
        }
        return new Promise((resolveResult, reject) => {
          const args = /^git(?:\.(?:exe|cmd|bat|com))?$/i.test(
            basename(argv[0]),
          )
            ? [
                '-c',
                `core.hooksPath=${process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null'}`,
                ...argv.slice(1),
              ]
            : argv.slice(1)
          const child = spawn(argv[0], args, {
            cwd: resolvePath(init.cwd ?? '.'),
            env: { ...process.env, ...init.env },
            stdio: ['pipe', 'pipe', 'pipe'],
            // A group remains addressable when the parent exits but descendants hold pipes.
            detached: process.platform !== 'win32',
            windowsHide: true,
          })
          let stopped: Error | undefined
          let termination: Promise<void> = Promise.resolve()
          const cleanup = () => {
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
          }
          const stop = (error: Error) => {
            if (stopped) return
            stopped = error
            cleanup()
            termination = new Promise<void>((done) => {
              const finish = (killError?: Error) => {
                if (killError)
                  stopped = new AggregateError(
                    [error, killError],
                    'Process tree termination failed',
                  )
                child.stdin.destroy()
                child.stdout.destroy()
                child.stderr.destroy()
                done()
              }
              if (child.pid === undefined) return finish()
              if (process.platform === 'win32') {
                treeKill(child.pid, 'SIGKILL', finish)
              } else {
                try {
                  process.kill(-child.pid, 'SIGKILL')
                  finish()
                } catch (killError) {
                  if ((killError as NodeJS.ErrnoException).code === 'ESRCH')
                    finish()
                  else treeKill(child.pid, 'SIGKILL', finish)
                }
              }
            })
          }
          const onAbort = () =>
            stop(new DOMException('Process aborted', 'AbortError'))
          const timer = setTimeout(
            () =>
              stop(
                new DOMException(
                  `Process timed out after ${timeoutMs}ms`,
                  'TimeoutError',
                ),
              ),
            timeoutMs,
          )
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
          const stdout: Buffer[] = []
          const stderr: Buffer[] = []
          let stdoutSize = 0
          let stderrSize = 0
          child.stdout.on('data', (chunk: Buffer) => {
            const kept = chunk.subarray(0, MAX_BYTES - stdoutSize)
            if (kept.length) stdout.push(kept)
            stdoutSize += kept.length
          })
          child.stderr.on('data', (chunk: Buffer) => {
            const kept = chunk.subarray(0, MAX_BYTES - stderrSize)
            if (kept.length) stderr.push(kept)
            stderrSize += kept.length
          })
          child.once('error', (error) => {
            cleanup()
            if (!stopped) reject(error)
          })
          child.once('close', async (code) => {
            cleanup()
            await termination
            if (stopped) reject(stopped)
            else {
              // Do not turn an incomplete UTF-8 tail at the cap into a larger replacement character.
              const decode = (chunks: Buffer[], size: number) => {
                const decoder = new StringDecoder('utf8')
                const text = decoder.write(Buffer.concat(chunks))
                return text + (size < MAX_BYTES ? decoder.end() : '')
              }
              resolveResult({
                exitCode: code ?? 1,
                stdout: decode(stdout, stdoutSize),
                stderr: decode(stderr, stderrSize),
              })
            }
          })
          child.stdin.on('error', () => {})
          child.stdin.end(init.stdin)
        })
      },
    },
    fs: {
      read,
      async ancestors(
        request: FsAncestorsRequest,
        signal: AbortSignal = activationSignal,
      ): Promise<readonly FsAncestor[]> {
        signal = AbortSignal.any([activationSignal, signal])
        signal.throwIfAborted()
        if (
          !request || typeof request !== 'object' || Array.isArray(request) ||
          !Array.isArray(request.names)
        )
          throw new TypeError('fs.ancestors request.names must be a string array')
        for (const name of request.names) {
          checkedString(name, 'fs.ancestors name')
          if (
            !name.endsWith('.md') || /^[\\/]/.test(name) ||
            /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..')
          )
            throw new TypeError('fs.ancestors names must be relative .md file names without ..')
        }
        for (const path of [request.of, request.below]) {
          if (path === undefined) continue
          checkedString(path, 'fs.ancestors path')
          if (!path || /^[\\/]{2}/.test(path))
            throw new TypeError('fs.ancestors paths must be nonempty local paths')
        }
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
          (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)
        )
          return []
        const projectRoot = resolve(root())
        const end = request.of === undefined ? projectRoot : dirname(resolvePath(request.of))
        const below = request.below === undefined ? undefined : resolvePath(request.below)
        if (below !== undefined) {
          const child = relative(below, end)
          if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return []
        }
        const dirs: string[] = []
        for (let dir = end; dir !== below; dir = dirname(dir)) {
          dirs.push(dir)
          if (dir === dirname(dir)) break
        }
        const result: FsAncestor[] = []
        let bytes = 0
        for (const dir of dirs.reverse()) {
          for (const name of request.names) {
            signal.throwIfAborted()
            const path = join(dir, name)
            let entry: Awaited<ReturnType<typeof stat>>
            try {
              entry = await stat(path)
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code
              if (code === 'ENOENT' || code === 'ENOTDIR') continue
              throw error
            }
            signal.throwIfAborted()
            if (!entry.isFile()) continue
            if (bytes + entry.size > MAX_BYTES) throw new RangeError('Read exceeds 4 MiB')
            // Basic FS and store calls must not eagerly load the query services.
            const { processMemoryFile } = await import('../../utils/claudemd.js')
            const { getCurrentProjectConfig } = await import('../../utils/config.js')
            signal.throwIfAborted()
            const includeExternal = getCurrentProjectConfig().hasClaudeMdExternalIncludesApproved ?? false
            const files = await new Promise<Awaited<ReturnType<typeof processMemoryFile>>>((resolveFiles, reject) => {
              const abort = () => reject(signal.reason)
              signal.addEventListener('abort', abort, { once: true })
              // The memory loader has no signal parameter; revoke the caller's wait,
              // without replacing its global filesystem implementation.
              void processMemoryFile(path, 'Project', new Set(), includeExternal, 0, undefined, projectRoot).then(
                files => {
                  signal.removeEventListener('abort', abort)
                  resolveFiles(files)
                },
                error => {
                  signal.removeEventListener('abort', abort)
                  reject(error)
                },
              )
            })
            signal.throwIfAborted()
            if (!files.length) continue
            for (const file of files) {
              bytes += Buffer.byteLength(file.rawContent ?? file.content, 'utf8')
              if (bytes > MAX_BYTES) throw new RangeError('Read exceeds 4 MiB')
            }
            const parts = files.map(({ path, content }) => ({ path, content }))
            result.push({ dir, name, content: parts.map(part => part.content).join('\n\n'), parts })
          }
        }
        signal.throwIfAborted()
        return result
      },
      async write(path: string, text: string, signal: AbortSignal = activationSignal): Promise<void> {
        signal.throwIfAborted()
        const target = resolvePath(path)
        if (typeof text !== 'string')
          throw new TypeError('text must be a string')
        if (Buffer.byteLength(text, 'utf8') > MAX_BYTES)
          throw new RangeError('Write exceeds 4 MiB')
        await mkdir(dirname(target), { recursive: true })
        signal.throwIfAborted()
        await writeFile(target, text, { encoding: 'utf8', signal })
      },
      async list(path = '.', signal: AbortSignal = activationSignal): Promise<FsEntry[]> {
        signal.throwIfAborted()
        const target = resolvePath(path)
        const entries = await readdir(target, { withFileTypes: true })
        signal.throwIfAborted()
        const result = await Promise.all(
          entries.map(async (entry) => ({
            name: entry.name,
            kind: kind(entry),
            isLink: entry.isSymbolicLink(),
            size: entry.isFile()
              ? await stat(resolve(target, entry.name)).then(
                  (s) => s.size,
                  () => 0,
                )
              : 0,
          })),
        )
        signal.throwIfAborted()
        return result.sort((a, b) => a.name.localeCompare(b.name))
      },
      async exists(path: string, signal: AbortSignal = activationSignal): Promise<boolean> {
        signal.throwIfAborted()
        const target = resolvePath(path)
        const exists = await stat(target).then(() => true, () => false)
        signal.throwIfAborted()
        return exists
      },
      async stat(
        path: string,
        options: FsStatOptions = { resolve: false },
        signal: AbortSignal = activationSignal,
      ): Promise<FsStat> {
        signal.throwIfAborted()
        if (!options || typeof options !== 'object' || Array.isArray(options) ||
            typeof options.resolve !== 'boolean')
          throw new TypeError('fs.stat options.resolve must be a boolean')
        const target = resolvePath(path)
        const entry = await lstat(target)
        signal.throwIfAborted()
        const isLink = entry.isSymbolicLink()
        let info = entry
        if (isLink) {
          try {
            info = await stat(target)
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
          }
          signal.throwIfAborted()
        }
        const result: FsStat = { kind: kind(info), size: info.size, mtimeMs: info.mtimeMs, isLink }
        if (options.resolve) {
          try {
            result.realPath = await realpath(target)
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
          }
          signal.throwIfAborted()
        }
        return result
      },
    },
  }
}
