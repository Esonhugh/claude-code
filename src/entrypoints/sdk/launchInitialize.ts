import { resolve } from 'path'
import { z } from 'zod'
import { SDKLocalPluginSchema } from './controlSchemas.js'

export type LaunchInitializeResult =
  | { kind: 'absent' }
  | { kind: 'violation'; message: string }
  | { kind: 'applied'; pluginDirs: string[]; pluginDirsNoMcp: string[]; pluginCount: number }

const pluginsSchema = () => z.array(SDKLocalPluginSchema()).optional()
const firstLineLimit = 268435456 // Official 2.1.292: UTF-16 string length, before the next chunk.

function parseLaunchLine(line: string): LaunchInitializeResult {
  let message: unknown
  try { message = JSON.parse(line.trim()) } catch {
    return { kind: 'violation', message: 'Error: --await-initialize requires the initialize control request as the first stdin line, and the first line is not valid JSON.' }
  }
  if (message === null || typeof message !== 'object' || !('type' in message) ||
      message.type !== 'control_request' || !('request' in message) ||
      message.request === null || typeof message.request !== 'object' ||
      !('subtype' in message.request) || message.request.subtype !== 'initialize') {
    return { kind: 'violation', message: 'Error: --await-initialize requires the initialize control request as the first stdin line, and the first line is a different message.' }
  }
  const parsed = pluginsSchema().safeParse('plugins' in message.request ? message.request.plugins : undefined)
  if (!parsed.success) {
    return { kind: 'violation', message: "Error: initialize.plugins must be an array of { type: 'local', path: string, skipMcpDiscovery?: boolean } entries." }
  }
  const plugins = parsed.data ?? []
  return {
    kind: 'applied', pluginCount: plugins.length,
    pluginDirs: plugins.filter(plugin => !plugin.skipMcpDiscovery).map(plugin => plugin.path),
    pluginDirsNoMcp: plugins.filter(plugin => plugin.skipMcpDiscovery).map(plugin => plugin.path),
  }
}

/** Peek the launch request, then hand the same stream (including every peeked chunk)
 * to StructuredIO. Drain during startup so a parent's pipe cannot deadlock. */
export function captureLaunchInitialize(source: AsyncIterable<string>): {
  ready: Promise<LaunchInitializeResult>
  input: AsyncIterable<string>
} {
  const iterator = source[Symbol.asyncIterator]()
  const stash: string[] = []
  let pending: Promise<IteratorResult<string>> | undefined
  let ended = false
  let capped = false
  let adopted = false
  let readError: unknown
  const read = () => {
    pending = iterator.next().then(result => {
      pending = undefined
      if (result.done) ended = true
      else stash.push(result.value)
      return result
    }, error => {
      pending = undefined
      readError = error
      throw error
    })
    return pending
  }
  const ready = (async (): Promise<LaunchInitializeResult> => {
    let text = ''
    for (;;) {
      const newline = text.indexOf('\n')
      if (newline !== -1) {
        const line = text.slice(0, newline)
        if (line.trim() !== '') return parseLaunchLine(line)
        text = text.slice(newline + 1)
        continue
      }
      if (text.length > firstLineLimit) { capped = true; return { kind: 'absent' } }
      const result = await read()
      if (result.done) return { kind: 'absent' }
      text += result.value
    }
  })().catch((): LaunchInitializeResult => ({ kind: 'absent' }))
  void ready.then(async () => {
    while (!adopted && !ended && !capped && readError === undefined) await read()
  }).catch(() => {}) // The adopted stream forwards the original read error.
  const input = (async function* () {
    await ready
    adopted = true
    let delegated = false
    try {
      while (stash.length) yield stash.shift()!
      if (pending) await pending.catch(() => {})
      while (stash.length) yield stash.shift()!
      if (readError !== undefined) throw readError
      if (ended) return
      delegated = true
      yield* { [Symbol.asyncIterator]: () => iterator }
    } finally {
      if (!delegated && !ended) await iterator.return?.()
    }
  })()
  return { ready, input }
}

/** A receipt, never an instruction to load plugins after launch. */
export function getInitializePluginsApplied(
  plugins: unknown,
  pluginDirs: readonly string[],
  pluginDirsNoMcp: readonly string[],
  cwd = process.cwd(),
): boolean | undefined {
  const parsed = pluginsSchema().safeParse(plugins)
  if (!parsed.success) return false
  if (!parsed.data?.length) return undefined
  const regular = new Set(pluginDirs.map(path => resolve(cwd, path)))
  const noMcp = new Set(pluginDirsNoMcp.map(path => resolve(cwd, path)))
  return parsed.data.every(plugin => (plugin.skipMcpDiscovery ? noMcp : regular).has(resolve(cwd, plugin.path)))
}
