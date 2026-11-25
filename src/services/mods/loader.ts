import { OFFICIAL_CORE_CALLS } from './coreCalls.js'
import { parse } from 'acorn'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { engineFormOf } from './engineForm.js'
import { isModBroadEventPattern, EMPTY_MOD_EVENT_PATTERN_ERROR, isModEventPattern, matchesModEventPattern, normalizeModMatcher } from './matcher'
import type { ModDeclaration, ModInput, ModRegistration, ModStateReference, ModTier } from './types'

// Deliberately a small authoring language, not the official parser or a security sandbox.
// The host must also validate registrations and actual capability requests.
type Node = { type: string; [key: string]: any }
type Role = 'register' | 'on' | 'engine' | 'beneath' | 'next' | null
type Scope = Map<string, Binding>[]
type Binding = {
  role?: Role
  members?: string[]
  namespace?: string
  fn?: { node: Node; scope: Scope; path: string }
  alias?: { node: Node; scope: Scope }
  imported?: { path: string; name: string }
  writes?: Map<Node, Map<Scope, Binding>>
}
type Capability = { role: Exclude<Role, null>; members: string[] }
type Resolved = { binding: Binding; members: string[] }
const tiers: ModTier[] = ['prepend', 'user', 'append', 'builtin', 'core']
export const coreNouns: ReadonlySet<string> = new Set([
  ...OFFICIAL_CORE_CALLS.map(call => call.split('.')[0]!),
  'engine', 'plugin', 'session', 'tool', 'clock', 'command', 'config', 'agent', 'mcp',
  'prompt', 'model', 'turn', 'ui', 'fs', 'http', 'process', 'store', 'state', 'settings', 'env', 'wasm',
])
const supportedEvents = new Set([
  'engine.create', 'plugin.register', 'session.start', 'session.end', 'session.stop', 'session.receive', 'session.send', 'session.compact', 'session.append', 'session.attach', 'session.detach', 'session.measure', 'tool.call', 'tool.check',
  'clock.now', 'clock.sleep', 'clock.after', 'clock.every', 'mcp.call',
  'config.set', 'config.describe', 'session.authorize', 'http.fetch',
  'fs.read', 'fs.write', 'fs.list', 'fs.exists', 'fs.stat', 'fs.ancestors', 'process.run', 'process.spawn',
  'store.get', 'store.set', 'store.delete', 'store.keys', 'state.get', 'state.set', 'env.get', 'env.set',
  'session.cwd', 'session.root', 'session.model', 'session.turns', 'session.id', 'session.repo', 'session.surface', 'session.surfaces', 'session.messages', 'session.usage', 'session.version', 'session.info', 'session.machine', 'process.hookEnv', 'ui.cancelNotify', 'session.identity',
  'agent.spawn', 'agent.register', 'agent.list', 'agent.limits', 'agent.call', 'command.register', 'command.list', 'command.run', 'prompt.compose', 'prompt.autocomplete', 'prompt.edit', 'prompt.submit', 'prompt.mention', 'prompt.fill', 'prompt.read', 'prompt.suggest', 'model.complete', 'model.classify', 'model.fork', 'turn.start', 'turn.step', 'turn.complete', 'turn.abort',
  'ui.resolve', 'ui.render', 'ui.open', 'ui.close', 'ui.panes', 'ui.blit', 'ui.scroll', 'ui.focus', 'ui.invalidate', 'ui.notice', 'ui.log', 'ui.status', 'ui.toast', 'ui.notify', 'ui.selection', 'ui.copy',
  'mcp.connect',
  'ui.place', 'prompt.paint', 'theme.set', 'theme.clear', 'ui.pointer', 'ui.press', 'ui.input', 'ui.select', 'ui.message', 'ui.fault',
  'telemetry.log', 'telemetry.mark', 'wasm.compile',
])
const telemetryStreams = ['anthropic', 'collector']
const telemetryStreamHint = '"to" is a string literal, or a list of them, from "anthropic", "collector", written in the call, so the streams a module\'s hooks stand on can be listed'
// Official 2.1.329 ends every scan refusal with this.
const spellingHint = '$ is always spelled $.noun.event(...) at the call site, on is always on("<event>", hook), and next.to always next.to(e, "<tier>")'
const itselfUses: Record<string, string> = {
  VariableDeclarator: 'bound to a name', AssignmentExpression: 'assigned', SpreadElement: 'spread', ReturnStatement: 'returned',
  ArrowFunctionExpression: 'returned', Property: 'put in an object', ArrayExpression: 'put in an array',
  ChainExpression: 'optionally chained', TemplateLiteral: 'put in a template',
}

const scanOnlyEvents = new Set([
  'prompt.section', 'prompt.context', 'prompt.attachment', 'skill.prompt', 'attribution.text',
  'settings.read', 'tool.describe', 'command.describe', 'tool.judge', 'tool.run', 'tool.offer', 'agent.report', 'agent.offer',
  'tool.register', 'tool.list',
])
// Nouns whose events the engine dispatches itself; an event on any other noun needs a loaded plugin to provide it.
export const engineEventNouns = new Set([...coreNouns, ...[...supportedEvents, ...scanOnlyEvents].map(event => event.split('.')[0]!), 'classic', 'theme'])
const supportedCalls = new Set([...supportedEvents].filter(event => ![
  'engine.create', 'plugin.register', 'session.start', 'session.end', 'session.stop', 'session.receive', 'session.compact', 'session.measure', 'tool.call', 'command.run', 'turn.start', 'turn.complete', 'ui.render',
  'ui.pointer', 'ui.press', 'ui.input', 'ui.select', 'ui.fault', 'config.describe', 'prompt.autocomplete', 'prompt.edit', 'prompt.mention',
].includes(event)))
for (const call of OFFICIAL_CORE_CALLS) supportedCalls.add(call)
supportedCalls.add('config.list')
supportedCalls.add('mcp.call')
const scanOnlyCalls = new Set(['settings.read', 'tool.list', 'tool.call', 'tool.register'])
const reserved = new Set(['__proto__', 'prototype', 'constructor'])
export const esmModuleExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.cts']

// loadModDeclaration names the plugin in front, as official 2.1.329 does: `<plugin>: <file>: <message>`.
class ModLoadError extends Error {}

function fail(path: string, message: string): never {
  throw new ModLoadError(`${path}: ${message}`)
}

// Official 2.1.329 scans a .js, .mjs or .cjs file as written and names its line; it names a compiled
// line of any other file with the line itself, cut at 80 characters.
function lineAt(line: number | undefined, compiled: string[] | undefined): string {
  const excerpt = line === undefined || compiled === undefined ? undefined : compiled[line - 1]?.trim() ?? ''
  return line === undefined ? '' : excerpt === undefined ? `:${line}` :
    `, compiled line ${line} \`${excerpt.length > 80 ? `${excerpt.slice(0, 80)}...` : excerpt}\``
}

function refusal(path: string, line: number | undefined, compiled: string[] | undefined, construct: string): ModLoadError {
  return new ModLoadError(`${path}${lineAt(line, compiled)}: ${construct}; ${spellingHint}`)
}

const scannedAsWritten = (path: string) => ['.js', '.mjs', '.cjs'].includes(extname(path))

function children(node: Node): Node[] {
  const result: Node[] = []
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) result.push(child)
    } else if (value && typeof value === 'object' && value.type) result.push(value)
  }
  return result
}

function isFunction(node: Node): boolean {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
}

function scan(programs: Map<string, Node>, links: ModDeclaration['links'], entrypoints: string[], compiledLines: Map<string, string[]>, defersEngineSpelling = false) {
  // A refusal names the line of the node the scan is at, unless it names a node itself.
  let at: Node | undefined
  function fail(file: string, message: string, node: Node | undefined = at): never {
    throw refusal(file, node?.loc?.start.line, compiledLines.get(file), message)
  }
  // Official 2.1.329 loads these spellings of an engine.create hook and judges them as it runs; its validate
  // names the hook outside its form instead, so validate reads on past them.
  let engineSpelling: string | undefined
  function failEngineSpelling(file: string, message: string, node: Node | undefined = at) {
    const error = refusal(file, node?.loc?.start.line, compiledLines.get(file), message)
    if (!defersEngineSpelling) throw error
    engineSpelling ??= error.message
  }
  const events = new Set<string>()
  const calls = new Set<string>()
  const registrationDescriptions = new Map<Node, { event: string; matcher?: Node; scope: Scope; hasCatch: boolean }>()
  const firstRegistrations = new Map<string, { path: string; line?: number }>()
  const directCalls = new Set<string>()
  const callsVia = new Map<string, Set<string>>()
  const otherConstantReads = new Set<Binding>()
  let helperName: string | undefined
  const env = { reads: new Set<string>(), writes: new Set<string>() }
  const state = { reads: new Map<string, ModStateReference>(), writes: new Map<string, ModStateReference>() }
  const nextTiers = new Set<ModTier>()
  const wasm = { literals: [] as { path: string; spelling: string; line?: number }[], isMadeAtRunTime: false }
  // Roles flow from register/handler parameters through lexical bindings and actual imports, never parameter names.
  const moduleScopes = new Map<string, Scope>()
  const registers = new Set<Node>()
  const engineNextBindings = new Set<Node>()
  const stateConstBindings = new Set<Binding>()
  const stateConstReads = new Set<Node>()
  let engineReturns = new Set<Node>()
  const activeHelpers = new Map<Node, Set<string>>()
  const scopes = new Map<object, Map<Scope, Map<string, Scope>>>()
  const helperCalls: { node: Node; scope: Scope; event?: string; path: string }[] = []
  const collectedFunctions = new Set<Scope>()
  let builtinObjectChanged = false
  let collecting = true
  let returningEngine = false
  let returningRegister = false
  let path = entrypoints[0]!
  const parents = new WeakMap<Node, Node>()
  for (const program of programs.values()) {
    const stack = [program]
    while (stack.length) {
      const node = stack.pop()!
      for (const child of children(node)) {
        parents.set(child, node)
        stack.push(child)
      }
    }
  }

  function cachedScope(key: object, outer: Scope, signature: string, create: () => Scope): Scope {
    let parents = scopes.get(key)
    if (!parents) scopes.set(key, parents = new Map())
    let contexts = parents.get(outer)
    if (!contexts) parents.set(outer, contexts = new Map())
    let inner = contexts.get(signature)
    if (!inner) contexts.set(signature, inner = create())
    return inner
  }

  function lookup(name: string, scope: Scope): Binding | undefined {
    for (let i = scope.length - 1; i >= 0; i--) {
      if (scope[i]!.has(name)) return scope[i]!.get(name)
    }
  }

  function exported(module: string, name: string, seen: Set<Binding>, trail = new Set<string>()): Resolved | undefined {
    const key = `${module}\0${name}`
    if (trail.has(key)) return
    const next = new Set(trail).add(key)
    const program = programs.get(module)
    if (!program) return
    const scope = moduleScopes.get(module)!
    for (const statement of program.body) {
      if (statement.type === 'ExportDefaultDeclaration' && name === 'default') {
        const node = statement.declaration
        if (isFunction(node)) {
          if (node.id) return resolveValue(node.id, scope, seen, next)
          return { binding: { fn: { node, scope, path: module } }, members: [] }
        }
        return resolveValue(node, scope, seen, next)
      }
      if (statement.type === 'ExportNamedDeclaration') {
        const declaration = statement.declaration
        if (declaration?.id?.name === name || declaration?.declarations?.some((item: Node) => item.id.name === name)) {
          return resolveValue({ type: 'Identifier', name }, scope, seen, next)
        }
        for (const item of statement.specifiers) {
          if ((item.exported.name ?? item.exported.value) !== name) continue
          if (statement.source) return exported(target(module, statement.source.value), item.local.name ?? item.local.value, seen, next)
          return resolveValue(item.local, scope, seen, next)
        }
      }
      if (statement.type === 'ExportAllDeclaration' && (statement.exported?.name ?? statement.exported?.value) === name) {
        return { binding: { namespace: target(module, statement.source.value) }, members: [] }
      }
    }
    let found: Resolved | undefined
    for (const statement of program.body) {
      if (statement.type === 'ExportAllDeclaration' && !statement.exported && name !== 'default') {
        const candidate = exported(target(module, statement.source.value), name, seen, next)
        if (candidate && found && candidate.binding !== found.binding) fail(module, `ambiguous helper export ${name}`)
        found ??= candidate
      }
    }
    return found
  }

  function target(from: string, specifier: string): string {
    return links.find(link => link.from === from && link.specifier === specifier)!.to
  }

  function resolveValue(node: Node, scope: Scope, seen = new Set<Binding>(), trail = new Set<string>()): Resolved | undefined {
    if (node.type === 'MemberExpression' && !node.computed && !node.optional) {
      const value = resolveValue(node.object, scope, seen, trail)
      if (value?.binding.namespace) return exported(value.binding.namespace, node.property.name, seen, trail)
      if (value) return { binding: value.binding, members: [...value.members, node.property.name] }
      return
    }
    if (node.type !== 'Identifier') return
    const binding = lookup(node.name, scope)
    if (!binding || seen.has(binding)) return
    const next = new Set(seen).add(binding)
    if (binding.writes) {
      let result: Resolved | undefined
      let unknown = false
      for (const contexts of binding.writes.values()) {
        for (const source of contexts.values()) {
          const value = source.alias ? resolveValue(source.alias.node, source.alias.scope, next, trail) : { binding: source, members: [] }
          if (!value || (!value.binding.role && !value.binding.fn)) {
            unknown = true
            continue
          }
          if (result && (result.binding.role !== value.binding.role ||
            result.members.join('.') !== value.members.join('.') ||
            result.binding.fn?.node !== value.binding.fn?.node || result.binding.fn?.scope !== value.binding.fn?.scope)) {
            if (!collecting && (result.binding.role || value.binding.role)) fail(path, 'mixed capability/helper assignments to a let capture are unsupported')
            unknown = true
          }
          result ??= value
        }
      }
      // A capability capture must stay traceable; a let holding several helpers (or none) is
      // only unresolved, so passing a capability to it still fails as an unknown helper.
      if (result && unknown && !collecting) {
        if (result.binding.role) fail(path, 'unknown assignment source for a capability/helper let capture is unsupported')
        return { binding, members: [] }
      }
      return result ?? { binding, members: [] }
    }
    if (binding.alias) return resolveValue(binding.alias.node, binding.alias.scope, next, trail)
    if (binding.imported) return exported(binding.imported.path, binding.imported.name, next, trail)
    return { binding, members: binding.members ?? [] }
  }

  function capabilityValue(node: Node, scope: Scope): Capability | undefined {
    const value = resolveValue(node, scope)
    if (!value?.binding.role) return
    if (value.binding.role === 'next' && ['signal', 'event', 'origin', 'trace', 'budget', 'error', 'called'].includes(value.members[0]!)) return
    if (['engine', 'beneath'].includes(value.binding.role) && value.members[0] === 'plugin') return
    return { role: value.binding.role, members: value.members }
  }

  function roleOf(node: Node, scope: Scope): Role {
    const value = capabilityValue(node, scope)
    return value && !value.members.length ? value.role : null
  }

  function scanEnvironment(call: string, node: Node) {
    if (call !== 'env.get' && call !== 'env.set') return
    const name = node.arguments[0]
    if (name?.type !== 'Literal' || typeof name.value !== 'string')
      fail(path, 'environment access requires a string literal name')
    if (!name.value || /[=\0]/.test(name.value))
      fail(path, 'environment name must be nonempty without NUL or =')
    env[call === 'env.get' ? 'reads' : 'writes'].add(name.value)
  }

  // Official 2.1.329 follows a name by its spelling across the whole file, not by scope: every
  // declaration of it must initialise it (to no other name) and nothing may assign it.
  const fileNames = new Map<Node, { declared: Map<string, (Node | null)[]>; assigned: Set<string> }>()
  function namesOf(program: Node) {
    let names = fileNames.get(program)
    if (names) return names
    const found = names = { declared: new Map<string, (Node | null)[]>(), assigned: new Set<string>() }
    const declare = (name: string, init: Node | null) => found.declared.set(name, [...found.declared.get(name) ?? [], init])
    const pattern = (node: Node | null | undefined, each: (name: string) => void): void => {
      switch (node?.type) {
        case 'Identifier': each(node.name); break
        case 'ObjectPattern': for (const property of node.properties) pattern(property.type === 'RestElement' ? property.argument : property.value, each); break
        case 'ArrayPattern': for (const element of node.elements) pattern(element, each); break
        case 'AssignmentPattern': pattern(node.left, each); break
        case 'RestElement': pattern(node.argument, each); break
      }
    }
    const walk = (node: Node) => {
      switch (node.type) {
        case 'VariableDeclarator':
          if (node.id.type === 'Identifier') declare(node.id.name, node.init ?? null)
          else pattern(node.id, name => declare(name, null))
          break
        case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
          if (node.id) declare(node.id.name, null)
          for (const param of node.params) pattern(param, name => declare(name, null))
          break
        case 'ClassDeclaration': case 'ClassExpression': if (node.id) declare(node.id.name, null); break
        case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': declare(node.local.name, null); break
        case 'CatchClause': pattern(node.param, name => declare(name, null)); break
        case 'AssignmentExpression': pattern(node.left, name => found.assigned.add(name)); break
        case 'UpdateExpression': pattern(node.argument, name => found.assigned.add(name)); break
        case 'ForInStatement': case 'ForOfStatement': if (node.left.type !== 'VariableDeclaration') pattern(node.left, name => found.assigned.add(name)); break
      }
      for (const child of children(node)) walk(child)
    }
    walk(program)
    fileNames.set(program, found)
    return found
  }

  // Official 2.1.329: a string-shaped argument that is no literal would name files the scan cannot list.
  function stringShaped(node: Node): boolean {
    switch (node.type) {
      case 'SpreadElement': case 'Literal': case 'TemplateLiteral': case 'BinaryExpression': return true
      case 'ConditionalExpression': return stringShaped(node.consequent) || stringShaped(node.alternate)
      case 'LogicalExpression': return stringShaped(node.right)
      case 'Identifier': {
        const program = programs.get(path)
        if (!program) return false
        const { declared, assigned } = namesOf(program)
        const inits = declared.get(node.name) ?? []
        return inits.length > 0 && !assigned.has(node.name) &&
          inits.every(init => init !== null && init.type !== 'Identifier' && stringShaped(init))
      }
      default: return false
    }
  }

  function wasmArgument(node: Node | undefined): string {
    switch (node?.type) {
      case undefined: return 'no argument'
      case 'Identifier': return `the variable ${node.name}`
      case 'TemplateLiteral': return 'a template with a substitution'
      case 'SpreadElement': return 'a spread'
      case 'Literal': return `the literal ${node.raw ?? String(node.value)}`
      case 'MemberExpression': return 'a member read'
      case 'CallExpression': return 'a call'
      case 'BinaryExpression': return 'a concatenation'
      default: return `a ${node.type}`
    }
  }

  function scanWasm(call: string, node: Node) {
    if (call !== 'wasm.compile') return
    const source = node.arguments[0] as Node | undefined
    const spelling = source && literalString(source)
    if (spelling !== undefined) {
      wasm.literals.push({ path, spelling, line: node.loc?.start.line })
      return
    }
    if (!source || stringShaped(source))
      fail(path, `$.wasm.compile takes a string literal naming a .wasm file of the plugin's own, so the files a module compiles can be listed, or bytes (got ${wasmArgument(source)})`)
    wasm.isMadeAtRunTime = true
  }

  function literalString(node: Node): string | undefined {
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value
    if (node.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0]?.value.cooked ?? undefined
  }

  function stateReference(node: Node, scope: Scope, resolving = new Set<Binding>()): ModStateReference | undefined {
    if (node.type === 'Identifier') {
      const binding = lookup(node.name, scope)
      if (!binding?.alias || resolving.has(binding)) return
      stateConstBindings.add(binding)
      stateConstReads.add(node)
      const next = new Set(resolving).add(binding)
      return stateReference(binding.alias.node, binding.alias.scope, next)
    }
    if (node.type !== 'ObjectExpression') return
    let reference: Partial<ModStateReference> = {}
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        const spread = stateReference(property.argument, scope, resolving)
        if (!spread) return
        reference = { ...reference, ...spread }
        continue
      }
      const key = property.computed ? undefined : property.key?.name ?? property.key?.value
      if (property.type !== 'Property' || property.kind !== 'init' || typeof key !== 'string') return
      if (key !== 'plugin' && key !== 'key') continue
      const value = literalString(property.value)
      if (value === undefined) return
      reference[key] = value
    }
    return typeof reference.plugin === 'string' && typeof reference.key === 'string'
      ? { plugin: reference.plugin, key: reference.key }
      : undefined
  }

  function stateHelper(node: Node, scope: Scope): string | undefined {
    if (node.type !== 'CallExpression' || node.optional || node.callee.type !== 'Identifier') return
    const imported = lookup(node.callee.name, scope)?.imported
    if (imported?.path === 'claude-code' && ['atom', 'derive', 'memberOf', 'read', 'update'].includes(imported.name))
      return imported.name
  }

  function stateSources(node: Node, scope: Scope, resolving = new Set<Binding>()): ModStateReference[] | undefined {
    if (node.type === 'Identifier') {
      const binding = lookup(node.name, scope)
      if (!binding?.alias || resolving.has(binding)) return
      const references = stateSources(binding.alias.node, binding.alias.scope, new Set(resolving).add(binding))
      if (references && (binding.alias.node.type === 'ObjectExpression' ||
        binding.alias.node.type === 'Identifier' && stateConstBindings.has(lookup(binding.alias.node.name, binding.alias.scope)!))) {
        stateConstBindings.add(binding)
        stateConstReads.add(node)
      }
      return references
    }
    const helper = stateHelper(node, scope)
    if (helper === 'atom' || helper === 'memberOf')
      return node.arguments[0] && stateSources(node.arguments[0], scope, resolving)
    if (helper === 'derive') {
      const sources = node.arguments[0]
      if (sources?.type !== 'ArrayExpression') return
      const references: ModStateReference[] = []
      for (const source of sources.elements) {
        const found = source && stateSources(source, scope, resolving)
        if (!found) return
        references.push(...found)
      }
      return references
    }
    const reference = stateReference(node, scope)
    return reference && [reference]
  }

  function scanState(call: string, node: Node, scope: Scope) {
    if (call !== 'state.get' && call !== 'state.set') return
    const reference = node.arguments[0]
    if (!reference || reference.type === 'SpreadElement')
      fail(path, 'state access requires a reference with literal plugin and key')
    const resolved = stateReference(reference, scope)
    if (!resolved) fail(path, 'state access requires a reference with literal plugin and key; only id may be computed')
    state[call === 'state.get' ? 'reads' : 'writes'].set(`${resolved.plugin}\0${resolved.key}`, resolved)
  }

  function bind(pattern: Node, bindings: Map<string, Binding>) {
    if (pattern.type === 'Identifier') bindings.set(pattern.name, {})
    else if (pattern.type === 'RestElement') bind(pattern.argument, bindings)
    else if (pattern.type === 'AssignmentPattern') bind(pattern.left, bindings)
    else if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties) bind(prop.type === 'RestElement' ? prop.argument : prop.value, bindings)
    } else if (pattern.type === 'ArrayPattern') {
      for (const item of pattern.elements) if (item) bind(item, bindings)
    }
  }

  function blockScope(body: Node[], scope: Scope, event?: string, key: object = body): Scope {
    return cachedScope(key, scope, event ?? '', () => createBlockScope(body, scope, event))
  }

  function createBlockScope(body: Node[], scope: Scope, event?: string): Scope {
    const bindings = new Map<string, Binding>()
    const inner = [...scope, bindings]
    for (const statement of body) {
      const node = ['ExportNamedDeclaration', 'ExportDefaultDeclaration'].includes(statement.type) ? statement.declaration : statement
      if (!node) continue
      if (node.type === 'VariableDeclaration') {
        for (const item of node.declarations) {
          bind(item.id, bindings)
          if (item.id.type === 'Identifier' && (node.kind === 'let' || node.kind === 'var')) {
            const binding: Binding = { writes: new Map() }
            bindings.set(item.id.name, binding)
          }
          if (item.id.type !== 'Identifier' || !item.init || node.kind !== 'const') continue
          bindings.set(item.id.name, isFunction(item.init)
            ? { fn: { node: item.init, scope: inner, path } }
            : { alias: { node: item.init, scope: inner } })
        }
      } else if (node.type === 'FunctionDeclaration') {
        if (node.id) bindings.set(node.id.name, { fn: { node, scope: inner, path } })
      } else if (node.type === 'ClassDeclaration') {
        if (node.id) bindings.set(node.id.name, {})
      } else if (node.type === 'ImportDeclaration') {
        for (const item of node.specifiers) {
          const to = target(path, node.source.value)
          bindings.set(item.local.name, item.type === 'ImportNamespaceSpecifier' ? { namespace: to } : {
            imported: { path: to, name: item.type === 'ImportDefaultSpecifier' ? 'default' : item.imported.name ?? item.imported.value },
          })
        }
      }
    }
    // Pre-bind next results so closures declared before the const cannot hide escapes.
    if (event !== 'engine.create') return inner
    for (const statement of body) {
      const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
      if (node?.type !== 'VariableDeclaration') continue
      for (const item of node.declarations) {
        const expression = item.init?.type === 'AwaitExpression' ? item.init.argument : item.init
        const callee = expression?.type === 'CallExpression' ? capabilityValue(expression.callee, inner) : undefined
        if (callee?.role === 'next' && (!callee.members.length || callee.members.join('.') === 'to')) {
          if (node.kind !== 'const') fail(path, 'the value of next(e) at engine.create is bound with let or var (const only)', node)
          // Official 2.1.329 withholds a noun as const { fs, ...beneath } = await next(e), leaving fs unread.
          const properties = item.id.type === 'ObjectPattern' ? item.id.properties : []
          const rest = properties.at(-1)
          const withheld = properties.slice(0, -1)
          const destructured = rest?.type === 'RestElement' && rest.argument.type === 'Identifier' &&
            withheld.every((property: Node) => property.type === 'Property' && property.shorthand && property.value.type === 'Identifier')
          if ((item.id.type !== 'Identifier' && !destructured) || item.init.type !== 'AwaitExpression') {
            failEngineSpelling(path, 'engine.create next result requires const identifier = await next(input) or const { noun, ...rest } = await next(input); aliases are unsupported', item)
          }
          const beneath = destructured ? rest.argument.name : item.id.name
          bindings.set(beneath, { role: 'beneath' })
          engineNextBindings.add(expression)
          refuseMemberValues(body, beneath, true)
          for (const property of withheld) refuseReads(body, property.value.name, item.id)
        }
      }
    }
    return inner
  }

  // Official accepts matchers computed at registration (a loop variable, a call); the Worker
  // reports the actual registration, so such parts are scanned as ordinary expressions.
  function matcher(node: Node, scope: Scope, nested = false, resolving = new Set<Binding>()) {
    if (node.type === 'Literal') {
      if (node.bigint !== undefined || (node.regex === undefined && node.value !== null && !['string', 'boolean', 'number'].includes(typeof node.value))) {
        fail(path, 'matcher contains an unsupported literal')
      }
      return
    }
    if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return
    if (node.type === 'Identifier') {
      const binding = lookup(node.name, scope)
      if (binding?.imported || binding?.namespace) return
      const initializer = binding?.alias
      if (binding && resolving.has(binding)) fail(path, 'matcher identifiers must reference imported or declared static constants')
      if (!binding || !initializer) {
        visit(node, scope)
        return
      }
      const next = new Set(resolving)
      next.add(binding)
      matcher(initializer.node, initializer.scope, true, next)
      return
    }
    if (node.type === 'MemberExpression') {
      if (node.computed || node.optional || node.object.type !== 'Identifier' || !(lookup(node.object.name, scope)?.imported || lookup(node.object.name, scope)?.namespace) ||
        node.property.type !== 'Identifier' || reserved.has(node.property.name)) {
        visit(node, scope)
      }
      return
    }
    if (node.type === 'ArrayExpression') {
      for (const item of node.elements) {
        if (!item) fail(path, 'matcher arrays cannot contain holes')
        matcher(item.type === 'SpreadElement' ? item.argument : item, scope, true, resolving)
      }
      return
    }
    if (isFunction(node)) fail(path, 'matcher must reference static constants/data')
    if (node.type !== 'ObjectExpression') {
      visit(node, scope)
      return
    }
    const keys = new Set<string>()
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        matcher(property.argument, scope, true, resolving)
        continue
      }
      const key = property.key?.name ?? property.key?.value
      if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init' ||
        typeof key !== 'string' || reserved.has(key) || keys.has(key)) {
        fail(path, 'matcher supports only unique static fields')
      }
      keys.add(key)
      matcher(property.value, scope, true, resolving)
    }
    if (!nested && !node.properties.length) return
  }

  function diagnosticString(value: string, quoted = false): string {
    if (!quoted && value.length <= 120 && /^(?!(?:true|false|null|undefined|NaN|Infinity)$)(?![-\d])[\w:@*!$#-]+$/.test(value)) return value
    const prefix = value.slice(0, 120)
    const text = JSON.stringify(prefix)
      .replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .replace(/ {2,}/g, spaces => ` ${spaces.slice(1).replaceAll(' ', '\\u0020')}`)
    return value.length === prefix.length ? text : `${text}[+${value.length - prefix.length} chars]`
  }

  function diagnosticNode(node: Node, scope: Scope, seen: Set<Binding>): { node: Node; scope: Scope; seen: Set<Binding> } | undefined {
    if (node.type !== 'Identifier') return { node, scope, seen }
    const binding = lookup(node.name, scope)
    const alias = binding?.alias
    if (!binding || !alias || alias.scope.length !== 1 || seen.has(binding)) return
    const aggregate = ['ObjectExpression', 'ArrayExpression'].includes(alias.node.type) || alias.node.regex !== undefined
    if (aggregate && otherConstantReads.has(binding)) return
    return diagnosticNode(alias.node, alias.scope, new Set(seen).add(binding))
  }

  function diagnosticObject(node: Node, scope: Scope, seen: Set<Binding>): string {
    const [only] = node.properties as Node[]
    if (node.properties.length === 1 && only?.type === 'Property') {
      const child = diagnosticNode(only.value, scope, seen)
      if (child?.node.type === 'ObjectExpression')
        return `.${diagnosticString(String(only.key.name ?? only.key.value))}${diagnosticObject(child.node, child.scope, child.seen)}`
    }
    return ` has {${diagnosticFields(node, scope, seen)}}`
  }

  function diagnosticFields(node: Node, scope: Scope, seen: Set<Binding>): string {
    const keys = node.properties.map((property: Node) => property.type === 'Property' ? String(property.key.name ?? property.key.value) : undefined)
    const lastSpread = keys.lastIndexOf(undefined)
    return node.properties.flatMap((property: Node, index: number) => {
      const key = keys[index]
      if (key === undefined) return ['...?']
      if (keys.includes(key, index + 1)) return []
      const name = diagnosticString(key)
      if (index < lastSpread) return [`${name}=?`]
      const value = diagnosticNode(property.value, scope, seen)
      return [value?.node.type === 'ObjectExpression'
        ? `${name}${diagnosticObject(value.node, value.scope, value.seen)}`
        : `${name}=${diagnosticMatcher(property.value, scope, seen)}`]
    }).join(', ')
  }

  function diagnosticMatcher(node: Node, scope: Scope, seen = new Set<Binding>()): string {
    const value = diagnosticNode(node, scope, seen)
    if (!value) return '?'
    node = value.node; scope = value.scope; seen = value.seen
    if (node.type === 'Literal') {
      if (node.regex) return `/${diagnosticString(node.regex.pattern, true)}/${node.regex.flags}`
      return typeof node.value === 'string' ? diagnosticString(node.value) : node.bigint !== undefined ? '?' : String(node.value)
    }
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis[0]?.value.cooked != null)
      return diagnosticString(node.quasis[0].value.cooked)
    if (node.type === 'ArrayExpression') return node.elements.map((item: Node | null) => item === null ? '' : diagnosticMatcher(item, scope, seen)).join('|')
    if (node.type === 'ObjectExpression') return `{${diagnosticFields(node, scope, seen)}}`
    return '?'
  }

  function recordCall(call: string) {
    calls.add(call)
    if (collecting) return
    if (helperName === undefined) directCalls.add(call)
    else {
      const via = callsVia.get(call) ?? new Set<string>()
      via.add(helperName)
      callsVia.set(call, via)
    }
  }

  function eventName(node: Node): string {
    if (node.type !== 'Literal' || typeof node.value !== 'string') fail(path, 'event must be a literal pattern string')
    const event = node.value as string
    if (event === '!*') fail(path, EMPTY_MOD_EVENT_PATTERN_ERROR)
    if (!isModEventPattern(event)) fail(path, 'event must be *, noun.*, !pattern, or a literal noun.method')
    const selected = event.startsWith('!') ? event.slice(1) : event
    if (selected !== '*' && !selected.endsWith('.*')) {
      const [noun, method] = selected.split('.') as [string, string]
      if (reserved.has(noun) || reserved.has(method) || (coreNouns.has(noun) && !supportedEvents.has(selected) && !scanOnlyEvents.has(selected))) {
        fail(path, `unsupported core event ${selected}`)
      }
    }
    return event
  }

  function patternNames(pattern: Node | null | undefined, names: string[] = []): string[] {
    if (pattern?.type === 'Identifier') names.push(pattern.name)
    else if (pattern?.type === 'AssignmentPattern') patternNames(pattern.left, names)
    else if (pattern?.type === 'RestElement') patternNames(pattern.argument, names)
    else if (pattern?.type === 'ArrayPattern') for (const item of pattern.elements) patternNames(item, names)
    else if (pattern?.type === 'ObjectPattern') {
      for (const property of pattern.properties) patternNames(property.type === 'RestElement' ? property.argument : property.value, names)
    }
    return names
  }

  // Whether node opens a scope of its own that declares name again.
  function redeclares(node: Node, name: string): boolean {
    const declared = (item: Node, kinds: string[]) => item.type === 'VariableDeclaration' && kinds.includes(item.kind) &&
      item.declarations.some((declarator: Node) => patternNames(declarator.id).includes(name))
    const lexical = (statements: Node[]) => statements.some(statement => declared(statement, ['let', 'const']) ||
      (['FunctionDeclaration', 'ClassDeclaration'].includes(statement.type) && statement.id?.name === name))
    const hoisted = (item: Node): boolean => !isFunction(item) && (declared(item, ['var']) || children(item).some(hoisted))
    if (isFunction(node)) {
      return (node.type !== 'FunctionDeclaration' && node.id?.name === name) ||
        node.params.some((param: Node) => patternNames(param).includes(name)) || children(node.body).some(hoisted)
    }
    if (node.type === 'BlockStatement' || node.type === 'StaticBlock') return lexical(node.body)
    if (node.type === 'SwitchStatement') return lexical(node.cases.flatMap((item: Node) => item.consequent))
    if (node.type === 'CatchClause') return patternNames(node.param).includes(name)
    if (['ForStatement', 'ForInStatement', 'ForOfStatement'].includes(node.type)) return declared(node.init ?? node.left ?? { type: '' }, ['let', 'const'])
    return false
  }

  // Official 2.1.329 takes a noun of $ only as $.noun.event(...) and $.plugin only as $.plugin.<name>;
  // the value of next(e) at engine.create is held to the same.
  const membersChecked = new Map<Node, Set<string>>()
  function refuseMemberValues(nodes: Node[], name: string, beneath = false) {
    const walk = (node: Node) => {
      if (redeclares(node, name)) return
      if (node.type === 'Identifier' && node.name === name) {
        let use = node
        let parent = parents.get(use)
        while (parent?.type === 'AwaitExpression') parent = parents.get(use = parent)
        if (beneath && parent?.type === 'VariableDeclarator' && parent.init === use && parent.id.type === 'ObjectPattern') {
          for (const property of parent.id.properties) if (property.value?.type === 'Identifier') refuseReads(nodes, property.value.name, parent.id)
        }
        if (parent?.type !== 'MemberExpression' || parent.object !== use) return
        if (parent.computed || parent.optional) fail(path, 'a computed or optional member access on $', parent)
        if (parent.property.type !== 'Identifier') fail(path, 'a member access on $ that is not a name', parent)
        const noun = parent.property.name
        const member = parents.get(parent)
        const named = member?.type === 'MemberExpression' && member.object === parent && !member.computed && !member.optional &&
          member.property.type === 'Identifier'
        if (noun === 'plugin') {
          if (named) return
          fail(path, '$.plugin is used other than as $.plugin.name or $.plugin.root', parent)
        }
        if (!named) fail(path, `$.${noun} is used as a value (a noun of $ bound, passed or read)`, parent)
        const call = parents.get(member)
        if (call?.type !== 'CallExpression' || call.callee !== member || call.optional) {
          fail(path, `$.${noun}.${member.property.name} is used as a value (an event of $ bound, passed or read) instead of called`, member)
        }
        return
      }
      for (const child of children(node)) walk(child)
    }
    for (const node of nodes) {
      const names = membersChecked.get(node) ?? new Set<string>()
      if (names.has(name)) continue
      membersChecked.set(node, names.add(name))
      walk(node)
    }
  }

  // A noun destructured from next(e) at engine.create is withheld, and official 2.1.329 refuses any read of it.
  function refuseReads(nodes: Node[], name: string, declaration: Node) {
    const walk = (node: Node) => {
      if (node === declaration || redeclares(node, name)) return
      const parent = parents.get(node)
      const named = (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
        (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type) && parent.key === node && !parent.computed && !parent.shorthand)
      if (node.type === 'Identifier' && node.name === name && !named) {
        fail(path, `"${name}", destructured from $ at engine.create, is read (a noun bound to a name); leave it unread or call it as $.noun.event(...)`, node)
      }
      for (const child of children(node)) walk(child)
    }
    nodes.forEach(walk)
  }

  function visitFunction(node: Node, scope: Scope, roles: (Capability | undefined)[] = [], event?: string, handler = false) {
    if (handler && (event === 'turn.step' || event === 'process.spawn')) {
      if (!node.async || !node.generator) fail(path, `${event} handlers must be async generators`)
    } else if (roles.length && node.generator) fail(path, 'generator register/handlers are unsupported')
    const inner = cachedScope(node, scope, JSON.stringify([event, handler, roles]), () => {
      const bindings = new Map<string, Binding>()
      if (node.id) bindings.set(node.id.name, { role: registers.has(node) ? 'register' : null, fn: { node, scope, path } })
      for (let i = 0; i < node.params.length; i++) {
        const param = node.params[i] as Node
        if ((roles[i] && param.type !== 'Identifier') || (roles.slice(i).some(Boolean) && param.type === 'RestElement')) fail(path, 'capability parameters must be simple identifiers (no destructuring/defaults/rest)')
        bind(param, bindings)
        if (roles[i]) bindings.set(param.name, { role: roles[i]!.role, members: roles[i]!.members })
        else if (roles.length && param.type === 'Identifier') bindings.set(param.name, { role: null })
      }
      return [...scope, bindings]
    })
    node.params.forEach((param: Node, index: number) => {
      if (roles[index]?.role === 'engine' && !roles[index]!.members.length && param.type === 'Identifier') refuseMemberValues([node.body], param.name)
    })
    if (collecting) {
      if (collectedFunctions.has(inner)) return
      collectedFunctions.add(inner)
    }
    const outerReturningEngine = returningEngine
    const outerReturningRegister = returningRegister
    const outerEngineReturns = engineReturns
    engineReturns = new Set()
    returningEngine = handler && event === 'engine.create'
    returningRegister = registers.has(node)
    for (const param of node.params) visitPattern(param, inner, event)
    if ((returningEngine || returningRegister) && node.body.type !== 'BlockStatement') {
      visit({ type: 'ReturnStatement', argument: node.body }, inner, event)
    } else visit(node.body, inner, event)
    returningEngine = outerReturningEngine
    returningRegister = outerReturningRegister
    engineReturns = outerEngineReturns
  }

  function visitPattern(node: Node, scope: Scope, event?: string) {
    if (node.type === 'AssignmentPattern') {
      visitPattern(node.left, scope, event)
      visit(node.right, scope, event)
    } else if (node.type === 'ObjectPattern') {
      for (const property of node.properties) {
        if (property.computed) visit(property.key, scope, event)
        visitPattern(property.type === 'RestElement' ? property.argument : property.value, scope, event)
      }
    } else if (node.type === 'ArrayPattern') {
      for (const item of node.elements) if (item) visitPattern(item, scope, event)
    } else if (node.type === 'RestElement') visitPattern(node.argument, scope, event)
  }

  function registration(node: Node, scope: Scope): string | undefined {
    if (node.type !== 'CallExpression' || roleOf(node.callee, scope) !== 'on') return
    if (node.optional) fail(path, 'optional registration is unsupported')
    if (node.arguments.length !== 2 && node.arguments.length !== 3) fail(path, 'on expects event, optional literal matcher, and inline handler')
    const event = eventName(node.arguments[0])
    if (!collecting && !registrationDescriptions.has(node) &&
      (node.arguments.length === 2 || isModBroadEventPattern(event))) {
      const first = firstRegistrations.get(event)
      const line = node.loc?.start.line
      if (first) fail(path, `on("${event}") registered twice${line === undefined ? '' : ` (compiled line ${line})`}; first at ${first.path}${first.line === undefined ? '' : ` (compiled line ${first.line})`}`)
      firstRegistrations.set(event, { path, ...(line === undefined ? {} : { line }) })
    }
    if (node.arguments.length === 3) matcher(node.arguments[1], scope)
    const handler = node.arguments.at(-1) as Node
    const resolved = isFunction(handler) ? undefined : resolveValue(handler, scope)
    const helper = resolved && !resolved.members.length && resolved.binding.fn
    if (!isFunction(handler) && (!helper || helper.scope.length !== 1 || helper.node.type !== 'FunctionDeclaration'))
      fail(path, 'on handler must be an inline function or a function declared at the top of its file (possibly imported)')
    events.add(event)
    if (!collecting) {
      const parent = parents.get(node)
      const hasCatch = parent?.type === 'MemberExpression' && parent.object === node && !parent.computed && parent.property.type === 'Identifier' && parent.property.name === 'catch'
      registrationDescriptions.set(node, { event, ...(node.arguments.length === 3 ? { matcher: node.arguments[1] } : {}), scope, hasCatch })
    }
    const callerPath = path
    try {
      if (helper) path = helper.path
      visitFunction(helper?.node ?? handler, helper?.scope ?? scope,
        [{ role: 'engine', members: [] }, undefined, { role: 'next', members: [] }], event, true)
    } finally { path = callerPath }
    return event
  }

  function capability(node: Node, scope: Scope): string | undefined {
    const value = capabilityValue(node, scope)
    if (!value || (value.role !== 'engine' && value.role !== 'beneath')) return
    const parts = value.members
    if (parts.length !== 2) fail(path, 'capabilities require static $.noun.method calls; computed/optional access is unsupported')
    const [noun, method] = parts as [string, string]
    if (reserved.has(noun) || reserved.has(method) || (coreNouns.has(noun) && !supportedCalls.has(`${noun}.${method}`) && !scanOnlyCalls.has(`${noun}.${method}`))) {
      fail(path, `unsupported core capability ${noun}.${method}`)
    }
    return `${noun}.${method}`
  }

  function captureWrite(target: Node, source: Node | undefined, site: Node, scope: Scope): boolean {
    if (target.type !== 'Identifier') return false
    const binding = lookup(target.name, scope)
    if (!binding?.writes) return false
    if (collecting) {
      let contexts = binding.writes.get(site)
      if (!contexts) binding.writes.set(site, contexts = new Map())
      contexts.set(scope, source && isFunction(source) ? { fn: { node: source, scope, path } } :
        source ? { alias: { node: source, scope } } : {})
    }
    return true
  }

  function validateHelperRoles(roles: (Capability | undefined)[]) {
    for (const value of roles) {
      if (!value) continue
      if (!['engine', 'beneath', 'next', 'on'].includes(value.role) || value.members.some(member => reserved.has(member)) ||
        (value.role === 'on' ? value.members.length !== 0 :
          value.role === 'next' ? !['', 'to', 'is'].includes(value.members.join('.')) : value.members.length > 2)) {
        fail(path, 'helpers require statically traceable capability members')
      }
    }
  }

  function identityValue(node: Node, scope: Scope): boolean {
    const value = capabilityValue(node, scope)
    return !!value && ['engine', 'beneath'].includes(value.role) && !value.members.length
  }

  function isItself(node: Node | undefined, scope: Scope): boolean {
    const value = node && capabilityValue(node, scope)
    return !!value && value.role === 'engine' && !value.members.length
  }

  // Official 2.1.329 takes $ only as $.noun.event(...), $.plugin or the argument of a plain helper call.
  function refuseItself(node: Node): never {
    let use = node
    let parent = parents.get(use)
    while (parent?.type === 'AwaitExpression') parent = parents.get(use = parent)
    const how = parent?.type === 'CallExpression' || parent?.type === 'NewExpression'
      ? parent.callee === use ? 'called' : 'passed as an argument'
      : parent === undefined ? 'used' : itselfUses[parent.type] ?? `used in a ${parent.type}`
    fail(path, `$ itself is ${how} (bound, passed, spread, returned or read)`, node)
  }

  function visit(node: Node | null | undefined, scope: Scope, event?: string, standalone = false) {
    const outer = at
    if (node?.loc) at = node
    try { visitNode(node, scope, event, standalone) } finally { at = outer }
  }

  function visitNode(node: Node | null | undefined, scope: Scope, event?: string, standalone = false) {
    if (!node) return
    if (registers.has(node)) {
      if (!node.params.length) fail(path, 'register requires an on parameter')
      visitFunction(node, scope, [{ role: 'on', members: [] }])
      return
    }
    if (isFunction(node)) {
      visitFunction(node, scope, [], event)
      return
    }
    switch (node.type) {
      case 'Program': case 'BlockStatement': {
        const inner = node.type === 'Program' ? moduleScopes.get(path)! : blockScope(node.body, scope, event)
        for (const statement of node.body) visit(statement, inner, event)
        return
      }
      case 'ExpressionStatement': visit(node.expression, scope, event, true); return
      case 'ImportDeclaration': case 'ExportAllDeclaration': return
      case 'ExportNamedDeclaration': visit(node.declaration, scope, event); return
      case 'VariableDeclaration':
        for (const item of node.declarations) {
          visitPattern(item.id, scope, event)
          if ((node.kind === 'let' || node.kind === 'var') && item.init) captureWrite(item.id, item.init, item, scope)
          const alias = ['const', 'let', 'var'].includes(node.kind) && item.id.type === 'Identifier' && item.init && capabilityValue(item.init, scope)
          if (alias && ['engine', 'beneath', 'next'].includes(alias.role) && !isItself(item.init, scope)) {
            if ((alias.role === 'next' && !['', 'to', 'is'].includes(alias.members.join('.'))) ||
              (alias.role !== 'next' && alias.members.length > 2)) visit(item.init, scope, event)
          } else visit(item.init, scope, event)
        }
        return
      case 'CatchClause': {
        const inner = cachedScope(node, scope, event ?? '', () => {
          const bindings = new Map<string, Binding>()
          if (node.param) bind(node.param, bindings)
          return [...scope, bindings]
        })
        if (node.param) visitPattern(node.param, inner, event)
        visit(node.body, inner, event)
        return
      }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
        const declaration = node.init ?? node.left
        const inner = blockScope(declaration?.type === 'VariableDeclaration' ? [declaration] : [], scope, event, node)
        if (node.left?.type === 'VariableDeclaration') {
          for (const item of node.left.declarations) captureWrite(item.id, undefined, item, inner)
        } else if (node.left) {
          visit({ type: 'AssignmentExpression', left: node.left }, inner, event)
        }
        for (const child of children(node)) visit(child, inner, event)
        return
      }
      case 'SwitchStatement': {
        visit(node.discriminant, scope, event)
        const inner = blockScope(node.cases.flatMap((item: Node) => item.consequent), scope, event, node)
        for (const item of node.cases) {
          visit(item.test, inner, event)
          for (const statement of item.consequent) visit(statement, inner, event)
        }
        return
      }
      case 'UnaryExpression':
        if (node.operator !== 'delete') break
        // Deletion is a write too; validate it through the same lexical target checks.
        visit({ type: 'UpdateExpression', argument: node.argument }, scope, event)
        return
      case 'AssignmentExpression': case 'UpdateExpression': {
        const assigned = node.left ?? node.argument
        const directCapture = assigned.type === 'Identifier' && node.operator === '=' &&
          captureWrite(assigned, node.right, node, scope)
        const check = (pattern: Node) => {
          if (pattern.type === 'Identifier') {
            if (!directCapture || pattern !== assigned) captureWrite(pattern, undefined, node, scope)
            if (collecting && pattern.name === 'Object' && !lookup('Object', scope)) builtinObjectChanged = true
            const value = resolveValue(pattern, scope)
            if (!collecting && value?.binding.fn && !directCapture) fail(path, 'assignment to a static helper binding is unsupported')
          } else if (pattern.type === 'MemberExpression') {
            let root = pattern.object
            while (root.type === 'MemberExpression') root = root.object
            if (collecting && root.type === 'Identifier' && root.name === 'Object' && !lookup('Object', scope)) builtinObjectChanged = true
          } else if (pattern.type === 'Property') {
            check(pattern.value)
          } else if (pattern.type === 'AssignmentPattern') {
            check(pattern.left)
          } else {
            for (const child of children(pattern)) check(child)
          }
        }
        check(assigned)
        if (!directCapture) visit(assigned, scope, event)
        if (directCapture && standalone) {
          const value = capabilityValue(node.right, scope)
          if (value && ['engine', 'beneath', 'next'].includes(value.role) && !isItself(node.right, scope) &&
            (value.role === 'next' ? ['', 'to', 'is'].includes(value.members.join('.')) : value.members.length <= 2)) return
        }
        visit(node.right, scope, event)
        return
      }
      case 'BinaryExpression':
        if (!collecting && ['===', '!=='].includes(node.operator)) {
          for (const operand of [node.left, node.right]) {
            if (!identityValue(operand, scope) || isItself(operand, scope)) visit(operand, scope, event)
          }
          return
        }
        break
      case 'Identifier':
        if (lookup(node.name, scope)) otherConstantReads.add(lookup(node.name, scope)!)
        if (!collecting && stateConstBindings.has(lookup(node.name, scope)!) && !stateConstReads.has(node)) {
          fail(path, `state reference const ${node.name} may only be used by state.get/state.set references or object spreads`)
        }
        if (collecting) {
          // An escaped builtin (including aliases/mutator arguments) cannot authorize passing an engine later.
          if (['Object', 'globalThis', 'self', 'window'].includes(node.name) && !lookup(node.name, scope)) builtinObjectChanged = true
          return
        }
        if (capabilityValue(node, scope)) {
          const parent = parents.get(node)
          if (isItself(node, scope) && !(parent?.type === 'MemberExpression' && parent.object === node)) refuseItself(node)
          const message = `capability alias/escape of ${node.name} is unsupported; use const aliases or statically bound helpers`
          if (capabilityValue(node, scope)?.role !== 'beneath') fail(path, message)
          failEngineSpelling(path, message)
        }
        if (['eval', 'Function', 'require', 'arguments'].includes(node.name)) fail(path, `${node.name} and dynamic code/module loading are unsupported`)
        return
      case 'ImportExpression': fail(path, 'dynamic import is unsupported; use static relative imports')
      case 'MetaProperty': fail(path, 'import.meta is unsupported')
      case 'CallExpression': {
        if (roleOf(node.callee, scope) === 'on') {
          if (node.optional) fail(path, 'optional registration is unsupported')
          if (!standalone) fail(path, 'registration handle escape is unsupported; use on(...).catch(...) directly')
          registration(node, scope)
          return
        }
        const callee = node.callee as Node
        if (callee.type === 'MemberExpression' && callee.property.name === 'catch' &&
          callee.object.type === 'CallExpression' && roleOf(callee.object.callee, scope) === 'on') {
          if (!standalone) fail(path, 'registration handle escape is unsupported')
          if (node.optional || callee.optional || callee.computed) fail(path, 'computed/optional catch is unsupported')
          const hookEvent = registration(callee.object, scope)!
          if (hookEvent === 'engine.create') fail(path, 'engine.create catch is unsupported')
          if (node.arguments.length !== 1 || !isFunction(node.arguments[0])) fail(path, 'catch requires one inline handler')
          visitFunction(node.arguments[0], scope, [{ role: 'engine', members: [] }, undefined, { role: 'next', members: [] }], hookEvent, true)
          return
        }
        const stateOperation = stateHelper(node, scope)
        if (stateOperation) {
          const access = stateOperation === 'read' || stateOperation === 'update'
          const source = node.arguments[access ? 1 : 0]
          const references = stateOperation === 'derive'
            ? stateSources(node, scope)
            : source && stateSources(source, scope)
          if (!references) fail(path, 'state helper requires sources with literal plugin and key; only id may be computed')
          for (const reference of references) {
            const key = `${reference.plugin}\0${reference.key}`
            state.reads.set(key, reference)
            if (stateOperation === 'update') state.writes.set(key, reference)
          }
          if (access) {
            // A helper's own parameter has no role until a call site passes the engine; that visit checks it.
            const first = node.arguments[0]
            const firstBinding = first?.type === 'Identifier' ? lookup(first.name, scope) : undefined
            const isUnspecializedParameter = firstBinding !== undefined && Object.keys(firstBinding).length === 0
            if (!collecting && !isUnspecializedParameter && !['engine', 'beneath'].includes(roleOf(first, scope) ?? ''))
              fail(path, 'state helper requires the engine as its first argument')
            recordCall('state.get')
            if (stateOperation === 'update') recordCall('state.set')
          }
          for (const argument of node.arguments.slice(access ? 1 : 0)) visit(argument, scope, event)
          return
        }
        if (collecting) {
          if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' &&
            callee.object.name === 'Object' && !lookup('Object', scope) &&
            (callee.computed || callee.optional || !['isFrozen', 'keys', 'values', 'entries', 'fromEntries', 'is',
              'freeze', 'seal', 'isSealed', 'isExtensible', 'preventExtensions', 'create', 'assign', 'hasOwn',
              'getPrototypeOf', 'getOwnPropertyNames', 'getOwnPropertySymbols', 'getOwnPropertyDescriptor',
              'getOwnPropertyDescriptors', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(callee.property.name))) {
            builtinObjectChanged = true
          }
          helperCalls.push({ node, scope, event, path })
          visit(callee, scope, event)
          for (const argument of node.arguments) visit(argument, scope, event)
          return
        }
        if (!builtinObjectChanged && !lookup('Object', scope) && !node.optional &&
          callee.type === 'MemberExpression' && !callee.computed && !callee.optional &&
          callee.object.type === 'Identifier' && callee.object.name === 'Object' && callee.property.name === 'isFrozen' &&
          node.arguments.length === 1 && identityValue(node.arguments[0], scope) && !isItself(node.arguments[0], scope)) return
        if (isItself(callee, scope)) refuseItself(callee)
        const calleeCapability = capabilityValue(callee, scope)
        if (event === 'engine.create' && calleeCapability?.role === 'next' &&
          ['', 'to'].includes(calleeCapability.members.join('.')) &&
          !engineNextBindings.has(node) && !engineReturns.has(node)) {
          failEngineSpelling(path, 'engine.create next result escape is unsupported; bind const identifier = await next(input)')
        }
        const argumentsRoles = node.arguments.map((argument: Node) => capabilityValue(argument, scope))
        if (argumentsRoles.some(Boolean)) {
          const passed = node.arguments.find((argument: Node) => isItself(argument, scope))
          if (passed && (callee.type !== 'Identifier' || node.optional)) refuseItself(passed)
          const value = resolveValue(callee, scope)
          const helper = value && !value.members.length && value.binding.fn
          if (!helper || value.binding.role || node.optional || node.arguments.some((argument: Node) => argument.type === 'SpreadElement') ||
            argumentsRoles.some((argument: Capability | undefined) => argument && !['engine', 'beneath', 'next', 'on'].includes(argument.role))) {
            fail(path, `capability escape to unknown/dynamic helpers is unsupported (${callee.name ?? callee.type})`)
          }
          validateHelperRoles(argumentsRoles)
          node.arguments.forEach((argument: Node, index: number) => {
            if (!argumentsRoles[index]) visit(argument, scope, event)
          })
          const signature = JSON.stringify([event, argumentsRoles])
          const active = activeHelpers.get(helper.node) ?? new Set<string>()
          if (!active.has(signature)) {
            activeHelpers.set(helper.node, active)
            active.add(signature)
            const callerPath = path
            const priorHelper = helperName
            helperName = callee.type === 'Identifier' ? callee.name : callee.property?.name
            path = helper.path
            try { visitFunction(helper.node, helper.scope, argumentsRoles, event) }
            finally { path = callerPath; helperName = priorHelper; active.delete(signature) }
          }
          return
        }
        const call = capability(callee, scope)
        if (call) {
          if (node.optional) fail(path, 'optional capability calls are unsupported')
          recordCall(call)
          scanEnvironment(call, node)
          scanState(call, node, scope)
          scanWasm(call, node)
        } else if (roleOf(callee, scope) === 'next') {
          if (node.optional || node.arguments.length !== 1) fail(path, 'next requires one input and a non-optional call')
        } else if (capabilityValue(callee, scope)?.role === 'next') {
          const method = capabilityValue(callee, scope)!.members.join('.')
          if (node.optional || callee.optional || callee.computed) fail(path, 'next supports only direct calls, next.is and literal next.to(input, tier)')
          if (method === 'is') {
            if (node.arguments.length !== 2) fail(path, 'next.is requires a literal event and input')
            eventName(node.arguments[0])
            visit(node.arguments[1], scope, event)
            return
          }
          if (method !== 'to') fail(path, 'next supports only direct calls, next.is and literal next.to(input, tier)')
          const tier = node.arguments[1]
          if (node.arguments.length !== 2 || tier?.type !== 'Literal' || !tiers.includes(tier.value)) fail(path, 'next.to tier must be a literal valid tier')
          nextTiers.add(tier.value)
        } else visit(callee, scope, event)
        for (const argument of node.arguments) visit(argument, scope, event)
        return
      }
      case 'MemberExpression':
        if (collecting) {
          if (node.object.type !== 'Identifier' || node.object.name !== 'Object' || lookup('Object', scope)) visit(node.object, scope, event)
          if (node.computed) visit(node.property, scope, event)
          return
        }
        if ((node.computed || node.optional) && capabilityValue(node.object, scope)) fail(path, 'computed/optional capability access is unsupported; next.to requires a literal tier')
        if (['engine', 'beneath'].includes(roleOf(node.object, scope) ?? '') &&
          !node.computed && !node.optional && node.property.name === 'plugin') return
        if (roleOf(node.object, scope) === 'next' && !node.computed && !node.optional &&
          ['signal', 'event', 'origin', 'trace', 'budget', 'error', 'called'].includes(node.property.name)) return
        visit(node.object, scope, event)
        if (node.computed) visit(node.property, scope, event)
        return
      case 'ReturnStatement': {
        const expression = node.argument?.type === 'AwaitExpression' ? node.argument.argument : node.argument
        if (returningRegister) {
          visit(expression, scope, event, true)
          return
        }
        if (returningEngine && expression?.type === 'CallExpression' && roleOf(expression.callee, scope) === 'next') engineReturns.add(expression)
        if (returningEngine && roleOf(node.argument ?? { type: '' }, scope) === 'beneath') return
        if (returningEngine && node.argument?.type === 'ObjectExpression') {
          for (const property of node.argument.properties) {
            if (property.type === 'SpreadElement' && roleOf(property.argument, scope) === 'beneath') continue
            const value = property.type === 'Property' && property.kind === 'init' && capabilityValue(property.value, scope)
            if (value && value.role === 'beneath' && value.members.length === 1 && !reserved.has(value.members[0]!)) {
              if (property.computed || (property.key.name ?? property.key.value) !== value.members[0]) {
                fail(path, 'engine noun aliases in provider returns are unsupported; preserve the original noun name')
              }
              continue
            }
            visit(property, scope, event)
          }
        } else visit(node.argument, scope, event)
        return
      }
      case 'Property': case 'MethodDefinition': case 'PropertyDefinition':
        if (node.computed) visit(node.key, scope, event)
        visit(node.value, scope, event)
        return
      case 'LabeledStatement': visit(node.body, scope, event); return
      case 'BreakStatement': case 'ContinueStatement': return
    }
    for (const child of children(node)) visit(child, scope, event)
  }
  for (const [module, program] of programs) {
    path = module
    moduleScopes.set(module, blockScope(program.body, []))
  }
  for (const module of entrypoints) {
    path = module
    const program = programs.get(module)!
    for (const statement of program.body) {
      if (statement.type === 'ExportNamedDeclaration' && statement.source &&
        statement.specifiers.some((item: Node) => (item.exported.name ?? item.exported.value) === 'register')) {
        fail(path, 're-exported register is unsupported; define register in the entrypoint')
      }
    }
    const value = exported(module, 'register', new Set())
    if (!value?.binding.fn) fail(path, 'entrypoint must export a named register function')
    if (value.binding.fn.path !== module) fail(path, 're-exported register is unsupported; define register in the entrypoint')
    registers.add(value.binding.fn.node)
    value.binding.role = 'register'
  }
  for (const [module, program] of programs) {
    path = module
    visit(program, [])
  }
  // Discover helper specializations before validating reads: captures may be assigned in later handlers/modules.
  let previousFunctions: number
  do {
    previousFunctions = collectedFunctions.size
    for (const call of [...helperCalls]) {
      path = call.path
      const value = resolveValue(call.node.callee, call.scope)
      const helper = value && !value.members.length && value.binding.fn
      const roles = call.node.arguments.map((argument: Node) => capabilityValue(argument, call.scope))
      if (!helper || value.binding.role || !roles.some(Boolean)) continue
      validateHelperRoles(roles)
      path = helper.path
      visitFunction(helper.node, helper.scope, roles, call.event)
    }
  } while (collectedFunctions.size !== previousFunctions)
  collecting = false
  for (const [module, program] of programs) {
    path = module
    visit(program, [])
  }
  // Official 2.1.292 lists the telemetry streams a module's hooks stand on from the
  // literal "to" of each telemetry hook's matcher; no "to" stands on every stream.
  function streamsOf(node: Node | undefined, event: string): string[] {
    const refuse = (message: string): never => fail(path, `on("${event}") ${message}; ${telemetryStreamHint}: on("${event}", { to: "collector" }, hook)`)
    if (node === undefined) return telemetryStreams
    if (node.type === 'ArrayExpression') return node.elements.flatMap((item: Node | null) =>
      item === null || item.type === 'SpreadElement' ? refuse('has a list of matchers with a hole or a spread') : streamsOf(item, event))
    if (node.type !== 'ObjectExpression') return refuse('takes its matcher as something other than an object written in the call')
    if (node.properties.some((item: Node) => item.type === 'SpreadElement' || item.computed || item.kind !== 'init'))
      refuse('has a matcher with a spread, a computed key or an accessor, which may set "to" to anything')
    const to = node.properties.filter((item: Node) => (item.key.type === 'Identifier' ? item.key.name : item.key.value) === 'to')
    if (to.length > 1) refuse('names "to" twice in one matcher')
    if (!to.length) return telemetryStreams
    const value = to[0].value as Node
    return (value.type === 'ArrayExpression' ? value.elements : [value]).map((item: Node | null) => {
      if (item === null) return refuse('names its destinations as a list with a hole')
      if (item.type !== 'Literal' || typeof item.value !== 'string') return refuse('names its destination as something other than a string literal')
      if (!telemetryStreams.includes(item.value)) return refuse(`names the destination "${item.value}", which is no telemetry stream`)
      return item.value as string
    })
  }
  const telemetryRegistrations = [...registrationDescriptions.values()].filter(({ event }) => event.startsWith('telemetry.'))
  const streams = new Set(telemetryRegistrations.flatMap(({ event, matcher }) => streamsOf(matcher, event)))
  const telemetry = telemetryRegistrations.length ? telemetryStreams.filter(stream => streams.has(stream)) : undefined
  return { events, calls, env, state, nextTiers, telemetry, wasm, engineSpelling, validation: {
    registrations: [...registrationDescriptions.values()].map(({ event, matcher, scope }) => matcher === undefined ? event : `${event}${diagnosticMatcher(matcher, scope)}`),
    gates: [...registrationDescriptions.values()].filter(({ event }) => isGate(event)).map(({ event, matcher, scope, hasCatch }) => ({
      registration: matcher === undefined ? event : `${event}${diagnosticMatcher(matcher, scope)}`,
      hasCatch,
    })),
    helperCalls: Object.fromEntries([...callsVia].filter(([call]) => !directCalls.has(call)).map(([call, via]) => [call, [...via].sort()])),
  } }
}

// Official 2.1.329's events and whether a hook on each can refuse it (a gate); a pattern no known event matches counts as one.
const eventGates: Record<string, boolean> = Object.fromEntries([
  ...['tool.call', 'tool.check', 'tool.judge', 'tool.run', 'tool.offer', 'agent.offer', 'agent.spawn', 'agent.report', 'prompt.submit', 'prompt.mention',
    'command.run', 'config.set', 'telemetry.log', 'telemetry.mark', 'plugin.register', 'session.receive', 'session.append', 'session.send',
    'session.compact', 'ui.scroll', 'ui.focus'].map(event => [event, true]),
  ...['tool.describe', 'prompt.fill', 'prompt.suggest', 'prompt.edit', 'prompt.change', 'prompt.autocomplete', 'prompt.section', 'prompt.context',
    'prompt.attachment', 'prompt.compose', 'command.describe', 'config.describe', 'skill.prompt', 'attribution.text', 'session.start', 'session.attach',
    'session.detach', 'session.measure', 'session.stop', 'session.end', 'turn.start', 'turn.step', 'turn.complete', 'ui.render', 'ui.resolve', 'ui.press',
    'ui.input', 'ui.select', 'ui.message', 'ui.fault', 'ui.pointer', 'engine.create'].map(event => [event, false]),
])

function isGate(pattern: string): boolean {
  const events = isModBroadEventPattern(pattern) ? Object.keys(eventGates).filter(event => matchesModEventPattern(pattern, event)) : [pattern]
  return events.length === 0 || events.some(event => eventGates[event] !== false)
}

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

export function validateModRegistrations(
  declaration: Pick<ModDeclaration, 'events'>,
  registrations: readonly ModRegistration[],
): ModRegistration[] {
  return registrations.map(registration => {
    if (!declaration.events.includes(registration.event)) {
      throw new Error('Actual module registration is absent from scan')
    }
    if (!Number.isSafeInteger(registration.id) || registration.id <= 0 ||
      typeof registration.hasCatch !== 'boolean' || !isModEventPattern(registration.event)) {
      throw new Error('Invalid actual module registration')
    }
    return {
      id: registration.id,
      event: registration.event,
      ...(registration.matcher === undefined ? {} : {
        matcher: normalizeModMatcher(registration.matcher) as ModRegistration['matcher'],
      }),
      hasCatch: registration.hasCatch,
    }
  })
}

type ModLoadInput = {
  /** Validate's reading: the engine.create hook in its one form, past the spellings official loads. */
  readsEngineForm?: boolean
  name: string
  storageId: string
  version?: string
  isNative?: boolean
  pluginRoot: string
  entrypoints: string[]
  options?: ModInput
  fingerprintOptions?: ModInput
  tier?: ModTier
}

export async function loadModDeclaration(input: ModLoadInput): Promise<ModDeclaration> {
  try {
    return await readModDeclaration(input)
  } catch (error) {
    if (error instanceof ModLoadError) throw new ModLoadError(`${input.name}: ${error.message}`)
    throw error
  }
}

async function readModDeclaration(input: ModLoadInput): Promise<ModDeclaration> {
  const root = resolve(input.pluginRoot)
  const rootReal = await realpath(root)
  const entrypoints = input.entrypoints.map(path => {
    if (!isAbsolute(path)) fail(path, 'entrypoint must be an absolute path resolved by the hooks adapter')
    return resolve(path)
  })
  if (!entrypoints.length) fail(root, 'at least one entrypoint is required')
  const modules: ModDeclaration['modules'] = []
  const links: ModDeclaration['links'] = []
  const events = new Set<string>()
  const calls = new Set<string>()
  const env = { reads: new Set<string>(), writes: new Set<string>() }
  const state = { reads: new Map<string, ModStateReference>(), writes: new Map<string, ModStateReference>() }
  const nextTiers = new Set<ModTier>()
  const seen = new Set<string>()
  const programs = new Map<string, Node>()
  const clients: NonNullable<ModDeclaration['clients']> = []
  const clientPaths = new Set<string>()
  const clientDeclarations: { path: string; specifier: string; start: number; end: number }[] = []
  const awaits = new Set<string>()
  const tier = input.tier ?? 'user'
  if (!tiers.includes(tier)) fail(root, `unsupported tier ${tier}`)
  const optionStack = new Set<object>()
  function snapshotOptions(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || optionStack.has(value) ||
      (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      fail(root, 'options must be acyclic JSON data with finite numbers')
    }
    optionStack.add(value)
    const result = Array.isArray(value) ? value.map(snapshotOptions) :
      Object.fromEntries(Object.keys(value).sort().map(key => [key, snapshotOptions((value as ModInput)[key])]))
    optionStack.delete(value)
    return result
  }
  const options = snapshotOptions(input.options ?? {}) as ModInput
  if (Array.isArray(options) || options === null || typeof options !== 'object') fail(root, 'options must be a JSON object')
  const fingerprintOptions = snapshotOptions(input.fingerprintOptions ?? options) as ModInput
  if (Array.isArray(fingerprintOptions) || fingerprintOptions === null || typeof fingerprintOptions !== 'object') fail(root, 'fingerprint options must be a JSON object')
  const transpilers = {
    ts: new Bun.Transpiler({
      loader: 'ts', target: 'browser', trimUnusedImports: false,
      deadCodeElimination: false, inline: false,
      tsconfig: JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
    }),
    tsx: new Bun.Transpiler({
      loader: 'tsx', target: 'browser', trimUnusedImports: false,
      deadCodeElimination: false, inline: false,
      tsconfig: JSON.stringify({ compilerOptions: {
        verbatimModuleSyntax: true, jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment',
      } }),
    }),
  }
  let bytes = 0
  async function resolveModule(from: string, specifier: string, description: string): Promise<string> {
    if (specifier !== '.' && specifier !== '..' && !specifier.startsWith('./') && !specifier.startsWith('../')) {
      fail(from, `${description} must be relative: ${specifier}`)
    }
    const requested = resolve(from, '..', specifier)
    if (!within(root, requested)) fail(from, `${description} is outside plugin root: ${specifier}`)
    const extension = extname(requested)
    const emittedExtension = extension === '.js' ? ['.ts', '.tsx'] : extension === '.jsx' ? ['.tsx'] : []
    const direct = extension ? [requested, ...emittedExtension.map(value => requested.slice(0, -extension.length) + value)] :
      [requested, ...esmModuleExtensions.map(value => requested + value)]
    const candidates = [...direct, ...direct.flatMap(candidate =>
      esmModuleExtensions.map(value => resolve(candidate, `index${value}`)),
    )]
    for (const candidate of candidates) {
      try {
        const metadata = await stat(candidate)
        if (metadata.isFile()) return candidate
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
      }
    }
    fail(from, `cannot resolve ${description} ${specifier}`)
  }
  async function load(path: string) {
    if (seen.has(path)) return
    if (!within(root, path)) fail(path, 'path is outside plugin root')
    const actual = await realpath(path)
    if (!within(rootReal, actual)) fail(path, 'realpath is outside plugin root')
    if (!esmModuleExtensions.includes(extname(path))) fail(path, 'only TS/JS ESM files are supported')
    if (!(await stat(actual)).isFile()) fail(path, 'module must be a regular file')
    if (seen.size >= 4096) fail(root, 'module graph exceeds 4096 files')
    seen.add(path)
    const file = await open(actual, 'r')
    let source: string
    try {
      const metadata = await file.stat()
      if (!metadata.isFile()) fail(path, 'module must be a regular file')
      if (metadata.size > 1024 * 1024) fail(path, 'module exceeds 1 MiB')
      const buffer = Buffer.alloc(1024 * 1024 + 1)
      let length = 0
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length > 1024 * 1024) fail(path, 'module exceeds 1 MiB')
      bytes += length
      if (bytes > 8 * 1024 * 1024) fail(root, 'module graph exceeds 8 MiB')
      source = buffer.toString('utf8', 0, length)
    } finally { await file.close() }
    let compiled: string
    let program: Node
    try {
      const extension = extname(path)
      const syntax = extension === '.tsx' || extension === '.jsx' ? 'tsx' : 'ts'
      compiled = scannedAsWritten(path) ? source : transpilers[syntax].transformSync(source, syntax)
      program = parse(compiled, { ecmaVersion: 'latest', sourceType: 'module', locations: true }) as unknown as Node
    } catch (error) {
      // Wording of official 2.1.329: each error the transpiler lists, with its position.
      const errors = (error as { errors?: unknown } | null)?.errors
      const words = (Array.isArray(errors) ? errors : [error]).map(item => {
        const { message, position } = (item ?? {}) as { message?: unknown; position?: { line?: unknown; column?: unknown } | null }
        const text = message === undefined ? '' : String(message)
        return typeof position?.line === 'number' && position.column !== undefined ? `${text} (line ${position.line}, column ${position.column})` : text
      }).filter(Boolean).join('; ') || String(error)
      throw new ModLoadError(`${path} does not parse: ${words}`)
    }
    function clientSpecifier(node: Node): Node | undefined {
      if (node.type !== 'CallExpression') return
      const callee = node.callee
      const direct = callee.type === 'Identifier' && callee.name === 'Client'
      const member = callee.type === 'MemberExpression' && !callee.computed && !callee.optional && callee.property.name === 'Client'
      const jsx = callee.type === 'Identifier' && callee.name === 'h' && node.arguments[0]?.type === 'Identifier' && node.arguments[0].name === 'Client'
      if (!direct && !member && !jsx) return
      const props = node.arguments[jsx ? 1 : 0]
      if (props?.type !== 'ObjectExpression') fail(path, 'Client requires an inline props object with a literal module')
      for (const property of props.properties) {
        const key = property.key?.name ?? property.key?.value
        if (property.type === 'Property' && !property.computed && key === 'module') return property.value
      }
      fail(path, 'Client module must be a string literal')
    }
    function collectClientModules(node: Node) {
      const value = clientSpecifier(node)
      if (value) {
        if (value.type !== 'Literal' || typeof value.value !== 'string') fail(path, 'Client module must be a string literal')
        if (value.value !== '.' && value.value !== '..' && !value.value.startsWith('./') && !value.value.startsWith('../')) {
          fail(path, `Client module must be relative: ${value.value}`)
        }
        const requested = resolve(path, '..', value.value)
        if (!within(root, requested)) fail(path, `Client module is outside plugin root: ${value.value}`)
        clientDeclarations.push({ path, specifier: value.value, start: value.start, end: value.end })
      }
      for (const child of children(node)) collectClientModules(child)
    }
    collectClientModules(program)
    modules.push({ path, source: compiled })
    programs.set(path, program)
    function hasTopLevelAwait(node: Node): boolean {
      if (isFunction(node)) return false
      return node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await) || children(node).some(hasTopLevelAwait)
    }
    if (hasTopLevelAwait(program)) awaits.add(path)
    for (const statement of program.body) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(statement.type) || !statement.source) continue
      const specifier = statement.source.value as string
      if (specifier === 'claude-code') {
        if (statement.type !== 'ImportDeclaration' || statement.specifiers.some((item: Node) =>
          item.type !== 'ImportNamespaceSpecifier' && (item.type !== 'ImportSpecifier' ||
            !['atom', 'derive', 'memberOf', 'read', 'update'].includes(item.imported.name ?? item.imported.value)))) {
          fail(path, 'claude-code runtime exports only atom, derive, memberOf, read and update')
        }
        links.push({ from: path, specifier, to: 'claude-code' })
        continue
      }
      if (specifier !== '.' && specifier !== '..' && !specifier.startsWith('./') && !specifier.startsWith('../')) fail(path, `bare/absolute imports are unsupported: ${specifier}`)
      const to = await resolveModule(path, specifier, 'relative import')
      links.push({ from: path, specifier, to })
      await load(to)
    }
  }
  for (const path of entrypoints) await load(path)
  const hookPaths = new Set(seen)
  const declarations = [...clientDeclarations]
  clientDeclarations.length = 0
  const replacements = new Map<string, { start: number; end: number; value: string }[]>()
  for (const declaration of declarations) {
    const to = await resolveModule(declaration.path, declaration.specifier, 'Client module')
    const module = relative(root, to).split(sep).join('/')
    const values = replacements.get(declaration.path) ?? []
    values.push({ start: declaration.start, end: declaration.end, value: JSON.stringify(module) })
    replacements.set(declaration.path, values)
    if (!clientPaths.has(to)) {
      clients.push({ path: to, module })
      clientPaths.add(to)
    }
    await load(to)
  }
  for (const [path, values] of replacements) {
    const snapshot = modules.find(module => module.path === path)!
    for (const replacement of values.sort((a, b) => b.start - a.start)) {
      snapshot.source = snapshot.source.slice(0, replacement.start) + replacement.value + snapshot.source.slice(replacement.end)
    }
  }
  for (const path of hookPaths) {
    const source = modules.find(module => module.path === path)!.source
    programs.set(path, parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true }) as unknown as Node)
  }
  for (const link of links) {
    if (awaits.has(link.to)) fail(link.to, 'top-level await in imported files is unsupported')
  }
  const compiledLines = new Map(modules.filter(module => hookPaths.has(module.path) && !scannedAsWritten(module.path))
    .map(module => [module.path, module.source.split('\n')]))
  const scanned = scan(new Map([...programs].filter(([path]) => hookPaths.has(path))), links, entrypoints, compiledLines, input.readsEngineForm)
  const entry = programs.get(entrypoints[0]!)
  const form = input.readsEngineForm && entry ? engineFormOf(entry, entrypoints[0]!) : undefined
  const engineForm = form?.isInForm === false ? { ...form, at: lineAt(form.line, compiledLines.get(form.file)) } : form
  for (const value of scanned.events) events.add(value)
  for (const value of scanned.calls) calls.add(value)
  for (const value of scanned.env.reads) env.reads.add(value)
  for (const value of scanned.env.writes) env.writes.add(value)
  for (const [key, value] of scanned.state.reads) state.reads.set(key, value)
  for (const [key, value] of scanned.state.writes) state.writes.set(key, value)
  for (const value of scanned.nextTiers) nextTiers.add(value)
  if (scanned.telemetry?.includes('anthropic') && tier !== 'builtin' && tier !== 'core')
    fail(root, 'hooks module not loaded; its hooks stand on the telemetry stream "anthropic" (a matcher names it, or a telemetry hook names no "to" and so stands on every stream), which is for the plugins built into the CLI; name the collector on each telemetry hook: on("telemetry.log", { to: "collector" }, hook) (policy/scan)')
  const relativePath = (path: string) => relative(root, path).split(sep).join('/')
  const wasmFiles = new Map<string, Set<string>>()
  for (const { path, spelling, line } of scanned.wasm.literals) {
    const refuse = (reason: string) => { throw refusal(path, line, compiledLines.get(path), `$.wasm.compile's path "${spelling}" ${reason}`) }
    if (!spelling.startsWith('./') && !spelling.startsWith('../')) refuse('is not relative: spell it from this file ("./engine.wasm")')
    if (!spelling.endsWith('.wasm')) refuse('does not end in .wasm')
    const target = resolve(dirname(path), spelling)
    if (!within(root, target) || target === root) refuse("leaves the plugin's folder")
    const spellings = wasmFiles.get(relativePath(target)) ?? new Set<string>()
    spellings.add(spelling)
    wasmFiles.set(relativePath(target), spellings)
  }
  // A saved binary changes the declaration, so the mod reloads with it; a missing one hashes as null.
  const wasmFile = async (path: string) => {
    const hash = createHash('sha256')
    try {
      for await (const chunk of createReadStream(resolve(root, ...path.split('/')))) hash.update(chunk as Buffer)
    } catch { return { path, spellings: [...wasmFiles.get(path)!].sort(), sha256: null } }
    return { path, spellings: [...wasmFiles.get(path)!].sort(), sha256: hash.digest('hex') }
  }
  const wasm = wasmFiles.size || scanned.wasm.isMadeAtRunTime ? {
    files: await Promise.all([...wasmFiles.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map(wasmFile)),
    ...(scanned.wasm.isMadeAtRunTime ? { isMadeAtRunTime: true as const } : {}),
  } : undefined
  // Absolute installation locations are plumbing, not declaration identity.
  const fingerprint = createHash('sha256').update(JSON.stringify({
    entrypoints: entrypoints.map(relativePath),
    modules: modules.map(module => ({ path: relativePath(module.path), source: module.source })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    clients: clients.map(client => ({ path: relativePath(client.path), module: client.module })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    options: fingerprintOptions, tier, ...(wasm ? { wasm } : {}),
  })).digest('hex')
  return {
    name: input.name, storageId: input.storageId, pluginRoot: root,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.isNative === true ? { isNative: true } : {}),
    entrypoints, modules, links, ...(clients.length ? { clients } : {}), ...(wasm ? { wasm } : {}), events: [...events], calls: [...calls].sort(),
    validation: { ...scanned.validation, ...(engineForm && { engineForm }), ...(scanned.engineSpelling && { engineSpelling: scanned.engineSpelling }) },
    ...(env.reads.size || env.writes.size ? { env: { reads: [...env.reads].sort(), writes: [...env.writes].sort() } } : {}),
    ...(state.reads.size || state.writes.size ? { state: {
      reads: [...state.reads.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value),
      writes: [...state.writes.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value),
    } } : {}),
    nextTiers: tiers.filter(value => nextTiers.has(value)), options, tier, fingerprint,
  }
}
