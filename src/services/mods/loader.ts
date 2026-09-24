import { parse } from 'acorn'
import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isModEventPattern, normalizeModMatcher } from './matcher'
import type { ModDeclaration, ModInput, ModRegistration, ModTier } from './types'

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
const coreNouns = new Set([
  'engine', 'plugin', 'session', 'tool', 'clock', 'command', 'config', 'agent', 'mcp',
  'prompt', 'model', 'turn', 'ui', 'fs', 'http', 'process', 'store', 'settings', 'env',
])
const supportedEvents = new Set([
  'engine.create', 'plugin.register', 'session.start', 'session.end', 'session.receive', 'session.compact', 'session.attach', 'session.detach', 'session.measure', 'tool.call', 'tool.check',
  'clock.now', 'clock.sleep', 'clock.after', 'clock.every', 'mcp.call',
  'config.set', 'config.describe', 'session.authorize', 'http.fetch',
  'fs.read', 'fs.write', 'fs.list', 'fs.exists', 'fs.stat', 'fs.ancestors', 'process.run',
  'store.get', 'store.set', 'store.delete', 'store.keys', 'env.get', 'env.set',
  'session.cwd', 'session.root', 'session.model', 'session.turns', 'session.id', 'session.repo', 'session.surface', 'session.surfaces', 'session.messages', 'session.usage',
  'agent.spawn', 'agent.register', 'agent.list', 'command.register', 'command.list', 'command.run', 'prompt.submit', 'prompt.fill', 'prompt.read', 'prompt.suggest', 'model.complete', 'model.classify', 'model.fork', 'turn.start', 'turn.step', 'turn.complete', 'turn.abort',
  'ui.resolve', 'ui.render', 'ui.open', 'ui.close', 'ui.scroll', 'ui.focus', 'ui.invalidate', 'ui.log', 'ui.status',
  'ui.press', 'ui.input', 'ui.select', 'ui.message',
])
const scanOnlyEvents = new Set([
  'prompt.section', 'prompt.context', 'prompt.attachment', 'skill.prompt', 'attribution.text',
  'settings.read', 'tool.describe', 'command.describe', 'agent.offer',
  'tool.register', 'tool.list',
])
const supportedCalls = new Set([...supportedEvents].filter(event => ![
  'engine.create', 'plugin.register', 'session.start', 'session.end', 'session.receive', 'session.compact', 'session.measure', 'tool.call', 'command.run', 'turn.start', 'turn.complete', 'ui.render',
  'ui.press', 'ui.input', 'ui.select', 'config.describe',
].includes(event)))
supportedCalls.add('config.list')
supportedCalls.add('mcp.call')
const scanOnlyCalls = new Set(['settings.read', 'tool.list', 'tool.call', 'tool.register'])
const reserved = new Set(['__proto__', 'prototype', 'constructor'])
const esmModuleExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.cts']

function fail(path: string, message: string): never {
  throw new Error(`Mod ${path}: ${message}`)
}

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

function scan(programs: Map<string, Node>, links: ModDeclaration['links'], entrypoints: string[]) {
  const events = new Set<string>()
  const calls = new Set<string>()
  const env = { reads: new Set<string>(), writes: new Set<string>() }
  const nextTiers = new Set<ModTier>()
  // Roles flow from register/handler parameters through lexical bindings and actual imports, never parameter names.
  const moduleScopes = new Map<string, Scope>()
  const registers = new Set<Node>()
  const engineNextBindings = new Set<Node>()
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
            if (!collecting) fail(path, 'mixed capability/helper assignments to a let capture are unsupported')
          }
          result ??= value
        }
      }
      if (result && unknown && !collecting) fail(path, 'unknown assignment source for a capability/helper let capture is unsupported')
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
          if (item.id.type === 'Identifier' && node.kind === 'let') {
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
          if (node.kind !== 'const' || item.id.type !== 'Identifier' || item.init.type !== 'AwaitExpression') {
            fail(path, 'engine.create next result requires const identifier = await next(input); aliases are unsupported')
          }
          bindings.set(item.id.name, { role: 'beneath' })
          engineNextBindings.add(expression)
        }
      }
    }
    return inner
  }

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
      if (!binding || !initializer || resolving.has(binding)) fail(path, 'matcher identifiers must reference imported or declared static constants')
      const next = new Set(resolving)
      next.add(binding)
      matcher(initializer.node, initializer.scope, true, next)
      return
    }
    if (node.type === 'MemberExpression') {
      if (node.computed || node.optional || node.object.type !== 'Identifier' || !(lookup(node.object.name, scope)?.imported || lookup(node.object.name, scope)?.namespace) ||
        node.property.type !== 'Identifier' || reserved.has(node.property.name)) {
        fail(path, 'matcher members must reference static imported constants')
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
    if (node.type !== 'ObjectExpression') fail(path, 'matcher must reference static constants/data')
    const keys = new Set<string>()
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        matcher(property.argument, scope, true, resolving)
        continue
      }
      const key = property.key?.name ?? property.key?.value
      if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init' || property.shorthand ||
        typeof key !== 'string' || reserved.has(key) || keys.has(key)) {
        fail(path, 'matcher supports only unique static fields')
      }
      keys.add(key)
      matcher(property.value, scope, true, resolving)
    }
    if (!nested && !node.properties.length) return
  }

  function eventName(node: Node): string {
    if (node.type !== 'Literal' || typeof node.value !== 'string') fail(path, 'event must be a literal pattern string')
    const event = node.value as string
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

  function visitFunction(node: Node, scope: Scope, roles: (Capability | undefined)[] = [], event?: string, handler = false) {
    if (handler && event === 'turn.step') {
      if (!node.async || !node.generator) fail(path, 'turn.step handlers must be async generators')
    } else if (roles.length && node.generator) fail(path, 'generator register/handlers are unsupported')
    const inner = cachedScope(node, scope, JSON.stringify([event, handler, roles]), () => {
      const bindings = new Map<string, Binding>()
      if (node.id) bindings.set(node.id.name, { role: registers.has(node) ? 'register' : null, fn: { node, scope, path } })
      for (let i = 0; i < node.params.length; i++) {
        const param = node.params[i] as Node
        if ((roles[i] && param.type !== 'Identifier') || (roles.slice(i).some(Boolean) && param.type === 'RestElement')) fail(path, 'capability parameters must be simple identifiers (no destructuring/defaults/rest)')
        bind(param, bindings)
        if (roles[i]) bindings.set(param.name, { role: roles[i]!.role, members: roles[i]!.members })
      }
      return [...scope, bindings]
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
    if (node.arguments.length === 3) matcher(node.arguments[1], scope)
    const handler = node.arguments.at(-1) as Node
    if (!isFunction(handler)) fail(path, 'on handler must be an inline function; imported/aliased handlers are unsupported')
    events.add(event)
    visitFunction(handler, scope, [{ role: 'engine', members: [] }, undefined, { role: 'next', members: [] }], event, true)
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
      if (!['engine', 'beneath', 'next'].includes(value.role) || value.members.some(member => reserved.has(member)) ||
        (value.role === 'next' ? !['', 'to', 'is'].includes(value.members.join('.')) : value.members.length > 2)) {
        fail(path, 'helpers require statically traceable capability members')
      }
    }
  }

  function identityValue(node: Node, scope: Scope): boolean {
    const value = capabilityValue(node, scope)
    return !!value && ['engine', 'beneath'].includes(value.role) && !value.members.length
  }

  function visit(node: Node | null | undefined, scope: Scope, event?: string, standalone = false) {
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
        if (node.kind === 'var') fail(path, 'var declarations are unsupported; use let/const lexical bindings')
        for (const item of node.declarations) {
          visitPattern(item.id, scope, event)
          if (node.kind === 'let' && item.init) captureWrite(item.id, item.init, item, scope)
          const alias = ['const', 'let'].includes(node.kind) && item.id.type === 'Identifier' && item.init && capabilityValue(item.init, scope)
          if (alias && ['engine', 'beneath', 'next'].includes(alias.role)) {
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
          if (value && ['engine', 'beneath', 'next'].includes(value.role) &&
            (value.role === 'next' ? ['', 'to', 'is'].includes(value.members.join('.')) : value.members.length <= 2)) return
        }
        visit(node.right, scope, event)
        return
      }
      case 'BinaryExpression':
        if (!collecting && ['===', '!=='].includes(node.operator)) {
          for (const operand of [node.left, node.right]) {
            if (!identityValue(operand, scope)) visit(operand, scope, event)
          }
          return
        }
        break
      case 'Identifier':
        if (collecting) {
          // An escaped builtin (including aliases/mutator arguments) cannot authorize passing an engine later.
          if (['Object', 'globalThis', 'self', 'window'].includes(node.name) && !lookup(node.name, scope)) builtinObjectChanged = true
          return
        }
        if (capabilityValue(node, scope)) fail(path, `capability alias/escape of ${node.name} is unsupported; use const aliases or statically bound helpers`)
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
          node.arguments.length === 1 && identityValue(node.arguments[0], scope)) return
        const calleeCapability = capabilityValue(callee, scope)
        if (event === 'engine.create' && calleeCapability?.role === 'next' &&
          ['', 'to'].includes(calleeCapability.members.join('.')) &&
          !engineNextBindings.has(node) && !engineReturns.has(node)) {
          fail(path, 'engine.create next result escape is unsupported; bind const identifier = await next(input)')
        }
        const argumentsRoles = node.arguments.map((argument: Node) => capabilityValue(argument, scope))
        if (argumentsRoles.some(Boolean)) {
          const value = resolveValue(callee, scope)
          const helper = value && !value.members.length && value.binding.fn
          if (!helper || value.binding.role || node.optional || node.arguments.some((argument: Node) => argument.type === 'SpreadElement') ||
            argumentsRoles.some((argument: Capability | undefined) => argument && !['engine', 'beneath', 'next'].includes(argument.role))) {
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
            path = helper.path
            visitFunction(helper.node, helper.scope, argumentsRoles, event)
            path = callerPath
            active.delete(signature)
          }
          return
        }
        const call = capability(callee, scope)
        if (call) {
          if (node.optional) fail(path, 'optional capability calls are unsupported')
          calls.add(call)
          scanEnvironment(call, node)
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
  return { events, calls, env, nextTiers }
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

export async function loadModDeclaration(input: {
  name: string
  storageId: string
  version?: string
  isNative?: boolean
  pluginRoot: string
  entrypoints: string[]
  options?: ModInput
  fingerprintOptions?: ModInput
  tier?: ModTier
}): Promise<ModDeclaration> {
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
    if (seen.size >= 512) fail(root, 'module graph exceeds 512 files')
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
      compiled = transpilers[syntax].transformSync(source, syntax)
      program = parse(compiled, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as Node
    } catch (error) { fail(path, `cannot parse/transpile module: ${error instanceof Error ? error.message : String(error)}`) }
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
        if (statement.type !== 'ImportDeclaration' || statement.specifiers.some((item: Node) => item.type !== 'ImportNamespaceSpecifier')) {
          fail(path, 'claude-code has an empty runtime namespace; use type-only or side-effect/namespace imports')
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
    programs.set(path, parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as Node)
  }
  for (const link of links) {
    if (awaits.has(link.to)) fail(link.to, 'top-level await in imported files is unsupported')
  }
  const scanned = scan(new Map([...programs].filter(([path]) => hookPaths.has(path))), links, entrypoints)
  for (const value of scanned.events) events.add(value)
  for (const value of scanned.calls) calls.add(value)
  for (const value of scanned.env.reads) env.reads.add(value)
  for (const value of scanned.env.writes) env.writes.add(value)
  for (const value of scanned.nextTiers) nextTiers.add(value)
  const relativePath = (path: string) => relative(root, path).split(sep).join('/')
  // Absolute installation locations are plumbing, not declaration identity.
  const fingerprint = createHash('sha256').update(JSON.stringify({
    entrypoints: entrypoints.map(relativePath),
    modules: modules.map(module => ({ path: relativePath(module.path), source: module.source })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    clients: clients.map(client => ({ path: relativePath(client.path), module: client.module })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    options: fingerprintOptions, tier,
  })).digest('hex')
  return {
    name: input.name, storageId: input.storageId, pluginRoot: root,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.isNative === true ? { isNative: true } : {}),
    entrypoints, modules, links, ...(clients.length ? { clients } : {}), events: [...events], calls: [...calls].sort(),
    ...(env.reads.size || env.writes.size ? { env: { reads: [...env.reads].sort(), writes: [...env.writes].sort() } } : {}),
    nextTiers: tiers.filter(value => nextTiers.has(value)), options, tier, fingerprint,
  }
}
