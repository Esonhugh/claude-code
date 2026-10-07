import type {
  SDKUIClientAddress,
  SDKUIRenderElement,
} from '../../entrypoints/sdk/modsControlTypes.js'

const instanceKey = (component: string, id: string) => `${component}\0${id}`
const clientKey = (plugin: string, module: string, key: string) =>
  `${plugin}\0${module}\0${key}`

/** Desktop Client addresses survive pending draws; only the newest generation publishes. */
export function createModRemoteClientRegistry() {
  const instances = new Map<
    string,
    {
      generation: number
      keys: Map<string, string>
      failed: Map<string, string>
    }
  >()
  let generation = 0
  const touch = (
    key: string,
    value: {
      generation: number
      keys: Map<string, string>
      failed: Map<string, string>
    },
  ) => {
    instances.delete(key)
    instances.set(key, value)
    if (instances.size > 1024) instances.delete(instances.keys().next().value!)
  }
  return {
    begin(component: string, id: string, version = '0') {
      const key = instanceKey(component, id)
      const token = { key, generation: ++generation, version }
      touch(key, {
        generation,
        keys: instances.get(key)?.keys ?? new Map(),
        failed: instances.get(key)?.failed ?? new Map(),
      })
      return token
    },
    record(
      token: { key: string; generation: number; version: string },
      tree: SDKUIRenderElement,
    ) {
      if (instances.get(token.key)?.generation !== token.generation) return
      const previous = instances.get(token.key)!
      const keys = new Map<string, string>()
      const visit = (node: SDKUIRenderElement | string) => {
        if (typeof node === 'string') return
        if (node.type === 'Client') {
          const key = clientKey(
            node.client.plugin,
            node.props.module,
            node.props.key,
          )
          keys.set(
            key,
            previous.failed.has(key)
              ? token.version
              : (previous.keys.get(key) ?? token.version),
          )
          return
        }
        if ('children' in node)
          for (const child of node.children ?? []) visit(child)
      }
      visit(tree)
      if (keys.size)
        touch(token.key, {
          generation: token.generation,
          keys,
          failed: new Map(
            [...previous.failed].filter(
              ([key, version]) => keys.has(key) && version === token.version,
            ),
          ),
        })
      else instances.delete(token.key)
    },
    has(address: SDKUIClientAddress) {
      const key = instanceKey(address.component, address.instance_id)
      const value = instances.get(key)
      if (
        !value?.keys.has(
          clientKey(address.plugin, address.module, address.client),
        )
      )
        return false
      touch(key, value)
      return true
    },
    toldFailed(
      address: SDKUIClientAddress,
      version: () => string,
    ): (() => string) | undefined {
      const instance = instanceKey(address.component, address.instance_id)
      const entry = instances.get(instance)
      const key = clientKey(address.plugin, address.module, address.client)
      const born = entry?.keys.get(key)
      if (!entry || born === undefined) return
      if (entry.failed.has(key)) return version
      touch(instance, {
        ...entry,
        failed: new Map([...entry.failed, [key, version()]]),
      })
      return () => born
    },
    remove(component: string, id: string) {
      instances.delete(instanceKey(component, id))
    },
    clear() {
      instances.clear()
    },
  }
}

/** Same conservative wire-data budgets as the official Client post contract. */
export function modClientDataProblem(value: unknown): string | undefined {
  let values = 0,
    characters = 0
  const path = new Set<object>()
  const visit = (value: unknown, depth: number): string | undefined => {
    if (depth > 32) return 'nests deeper than 32'
    values++
    characters +=
      typeof value === 'string'
        ? value.length + 2
        : typeof value === 'boolean' || value === null
          ? 5
          : typeof value === 'number'
            ? String(value).length
            : 2
    if (values > 20000) return 'holds more than 20000 values'
    if (characters > 100000) return 'serializes to more than 100000 characters'
    if (typeof value === 'number' && !Number.isFinite(value))
      return `holds ${String(value)}`
    if (
      value === null ||
      ['string', 'number', 'boolean'].includes(typeof value)
    )
      return
    if (value === undefined)
      return 'holds undefined (an array hole, a missing value)'
    if (typeof value !== 'object') return `holds ${typeof value}`
    if (path.has(value)) return 'holds a cycle'
    const proto = Object.getPrototypeOf(value)
    if (
      !Array.isArray(value) &&
      proto !== null &&
      Object.getPrototypeOf(proto) !== null
    )
      return 'holds an object that is not plain (a class instance)'
    path.add(value)
    const entries = Array.isArray(value)
      ? Array.from(
          { length: value.length },
          (_, index) => [1, value[index]] as const,
        )
      : Object.entries(value).map(
          ([key, child]) => [key.length + 4, child] as const,
        )
    for (const [length, child] of entries) {
      characters += length
      const problem = visit(child, depth + 1)
      if (problem) return problem
    }
    path.delete(value)
  }
  return visit(value, 0)
}

export function normalizeModClientFaultReason(
  plugin: string,
  module: string,
  reason: string,
): string {
  const truncate = (text: string, length: number) => {
    let value = text.slice(0, length)
    if (/[\ud800-\udbff]$/.test(value)) value = value.slice(0, -1)
    return value
  }
  // The official fault formatter replaces control characters with spaces.
  let text = reason.replace(
    // eslint-disable-next-line no-control-regex
    /[\t\n\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u{10eeee}\ud800-\udfff]/gu,
    ' ',
  )
  if (text.length > 500) text = truncate(text, 500) + '…'
  if (text.startsWith(`${plugin}: `)) text = text.slice(plugin.length + 2)
  if (text.startsWith(`Client ${module}: `))
    text = text.slice(module.length + 9)
  if (!text.trim()) text = 'the module failed without a message'
  text = text.replace(/[\u2028\u2029]/gu, ' ')
  return text.length > 200 ? truncate(text, 199) + '…' : text
}
