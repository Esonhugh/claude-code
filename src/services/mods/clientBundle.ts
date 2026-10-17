import { parse } from 'acorn'
import { createHash } from 'node:crypto'
import { relative, sep } from 'node:path'
import runtime from '../../../assets/mods-client-runtime-2.1.292.json'
import type { SDKControlUIClientModuleResponse } from '../../entrypoints/sdk/modsControlTypes.js'
import type { ModDeclaration } from './types.js'

const cache = new WeakMap<ModDeclaration, SDKControlUIClientModuleResponse>()
const limits = {
  nodes: 20000,
  depth: 32,
  chars: 100000,
  values: 20000,
  dataDepth: 32,
}
type Node = { type: string; start: number; end: number; [key: string]: any }
function children(node: Node): Node[] {
  return Object.values(node).flatMap((value) =>
    Array.isArray(value)
      ? value.filter((item) => item?.type)
      : value?.type
        ? [value]
        : [],
  )
}

/** Only admitted source snapshots are served. Client code stays outside the host realm. */
export function buildModClientBundle(
  declaration: ModDeclaration,
): SDKControlUIClientModuleResponse | undefined {
  if (!declaration.clients?.length) return undefined
  const previous = cache.get(declaration)
  if (previous) return structuredClone(previous)
  const snapshots = new Map(
    declaration.modules.map((module) => [module.path, module.source]),
  )
  const keyFor = (path: string) => {
    const name = relative(declaration.pluginRoot, path).split(sep).join('/')
    if (!name || name === '..' || name.startsWith('../'))
      throw new Error('Client module is outside the admitted plugin root')
    return 'surface:///' + name.split('/').map(encodeURIComponent).join('/')
  }
  const files = new Map(runtime.files.map((file) => [file.key, { ...file }]))
  const programs = new Map<string, Node>()
  const visit = (path: string) => {
    const key = keyFor(path)
    if (files.has(key)) return
    const source = snapshots.get(path)
    if (source === undefined)
      throw new Error('Client module is not in the admitted snapshot')
    const program = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    }) as unknown as Node
    programs.set(path, program)
    const links = declaration.links.filter((link) => link.from === path)
    const replace = (specifier: string) => {
      if (specifier === 'claude-code') return 'claude:hooks-types'
      const link = links.find((link) => link.specifier === specifier)
      return link && snapshots.has(link.to)
        ? keyFor(link.to)
        : 'surface-unlinked:///' + encodeURIComponent(specifier)
    }
    const edits: { start: number; end: number; text: string }[] = []
    const rewrite = (node: Node) => {
      const operand =
        node.type === 'ImportExpression'
          ? node.source
          : [
                'ImportDeclaration',
                'ExportNamedDeclaration',
                'ExportAllDeclaration',
              ].includes(node.type)
            ? node.source
            : undefined
      if (operand) {
        if (operand.type === 'Literal' && typeof operand.value === 'string')
          edits.push({
            start: operand.start,
            end: operand.end,
            text: JSON.stringify(replace(operand.value)),
          })
        else {
          // Insert wrappers, rather than replacing the expression: nested imports retain their edits.
          edits.push(
            {
              start: operand.start,
              end: operand.start,
              text: '("surface-unlinked:///computed#" + String(',
            },
            { start: operand.end, end: operand.end, text: '))' },
          )
        }
      }
      for (const child of children(node)) rewrite(child)
    }
    rewrite(program)
    let emitted = source
    for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end))
      emitted =
        emitted.slice(0, edit.start) + edit.text + emitted.slice(edit.end)
    files.set(key, { key, source: emitted })
    for (const link of links) if (snapshots.has(link.to)) visit(link.to)
  }
  const modules = declaration.clients.map((client) => {
    visit(client.path)
    const program = programs.get(client.path)!
    const exports: string[] = []
    for (const node of program.body as Node[]) {
      if (node.type === 'ExportDefaultDeclaration') exports.push('default')
      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration?.id) exports.push(node.declaration.id.name)
        for (const item of node.declaration?.declarations ?? [])
          if (item.id?.name) exports.push(item.id.name)
        for (const item of node.specifiers ?? [])
          exports.push(item.exported.name ?? item.exported.value)
      }
    }
    const components = exports.filter((name) => /^[A-Z]/.test(name))
    const component = exports.includes('default')
      ? 'default'
      : components.length === 1
        ? components[0]!
        : undefined
    if (!component)
      throw new Error(
        'Client module must export a default component or one named component',
      )
    return { module: client.module, entry: keyFor(client.path), component }
  })
  const payload = { files: [...files.values()], modules, limits }
  const bundle: SDKControlUIClientModuleResponse = {
    plugin: declaration.name,
    hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    modules,
    runtime: 'claude:surface-runtime',
    limits: { ...limits },
    files: payload.files,
  }
  cache.set(declaration, bundle)
  return structuredClone(bundle)
}
