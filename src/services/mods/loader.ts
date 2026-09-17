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
type Scope = Map<string, Role>[]
const tiers: ModTier[] = ['prepend', 'user', 'append', 'builtin', 'core']
const coreNouns = new Set([
  'engine', 'plugin', 'session', 'tool', 'clock', 'command', 'agent', 'mcp',
  'prompt', 'model', 'turn', 'ui', 'fs', 'http', 'process', 'store', 'settings', 'env',
])
const supportedEvents = new Set([
  'engine.create', 'plugin.register', 'session.start', 'tool.call',
  'clock.now', 'clock.sleep', 'clock.after', 'clock.every',
  'fs.read', 'fs.write', 'fs.list', 'fs.exists', 'fs.stat', 'process.run',
  'store.get', 'store.set', 'store.delete', 'store.keys',
  'session.cwd', 'session.id', 'session.surface', 'session.messages',
  'command.register', 'command.list', 'command.run', 'prompt.submit', 'turn.start', 'turn.complete',
  'ui.resolve', 'ui.render', 'ui.open', 'ui.close', 'ui.scroll', 'ui.focus', 'ui.invalidate', 'ui.log', 'ui.status',
  'ui.press', 'ui.input', 'ui.select',
])
const scanOnlyEvents = new Set([
  'prompt.section', 'prompt.context', 'skill.prompt', 'attribution.text',
  'settings.read', 'tool.describe', 'command.describe', 'agent.offer',
  'agent.spawn', 'tool.register', 'tool.list',
])
const supportedCalls = new Set([...supportedEvents].filter(event => ![
  'engine.create', 'plugin.register', 'session.start', 'tool.call', 'command.run', 'prompt.submit', 'turn.start', 'turn.complete', 'ui.render',
  'ui.press', 'ui.input', 'ui.select',
].includes(event)))
const scanOnlyCalls = new Set(['settings.read', 'tool.list'])
const reserved = new Set(['__proto__', 'prototype', 'constructor'])

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

function roleOf(node: Node, scope: Scope): Role {
  if (node.type !== 'Identifier') return null
  for (let i = scope.length - 1; i >= 0; i--) {
    if (scope[i]!.has(node.name)) return scope[i]!.get(node.name)!
  }
  return null
}

function scan(program: Node, path: string, entrypoint: boolean): {
  events: Set<string>
  calls: Set<string>
  nextTiers: Set<ModTier>
  helperCalls: Set<string>
  helperTiers: Set<ModTier>
  helpersAcceptingNext: Map<string, Set<number>>
  capabilityHelperCalls: { name: string; indexes: number[] }[]
  topLevelAwait: boolean
} {
  const events = new Set<string>()
  const calls = new Set<string>()
  const nextTiers = new Set<ModTier>()
  const functions = new Map<string, Node>()
  const importedBindings = new Set<string>()
  const matcherConstants = new Map<string, Node>()
  const helpersAcceptingNext = new Map<string, Set<number>>()
  const capabilityHelperCalls: { name: string; indexes: number[] }[] = []
  const helperCalls = new Set<string>()
  const helperTiers = new Set<ModTier>()
  const engineNextBindings = new Set<Node>()
  const engineReturns = new Set<Node>()
  let returningEngine = false
  let register: Node | undefined
  function hasTopLevelAwait(node: Node): boolean {
    if (isFunction(node)) return false
    return node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await) || children(node).some(hasTopLevelAwait)
  }
  const topLevelAwait = hasTopLevelAwait(program)

  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (declaration?.type === 'ImportDeclaration') {
      for (const item of declaration.specifiers) importedBindings.add(item.local.name)
    }
    if (declaration?.type === 'FunctionDeclaration') {
      functions.set(declaration.id.name, declaration)
      if (!entrypoint) {
        const indexes = new Set<number>()
        declaration.params.forEach((parameter: Node, index: number) => {
          if (parameter.type === 'Identifier' && parameter.name === 'next') indexes.add(index)
        })
        if (indexes.size) helpersAcceptingNext.set(declaration.id.name, indexes)
      }
    }
    if (declaration?.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) {
        if (item.id.type !== 'Identifier' || !item.init) continue
        if (isFunction(item.init)) functions.set(item.id.name, item.init)
        if (declaration.kind === 'const') matcherConstants.set(item.id.name, item.init)
      }
    }
  }
  if (entrypoint) {
    for (const statement of program.body) {
      if (statement.type !== 'ExportNamedDeclaration') continue
      const declaration = statement.declaration
      if (declaration?.type === 'FunctionDeclaration' && declaration.id.name === 'register') register = declaration
      if (declaration?.type === 'VariableDeclaration') {
        if (declaration.declarations.some((item: Node) => item.id.name === 'register')) register = functions.get('register')
      }
      for (const item of statement.specifiers ?? []) {
        if ((item.exported.name ?? item.exported.value) === 'register') {
          if (statement.source) fail(path, 're-exported register is unsupported; define register in the entrypoint')
          register = functions.get(item.local.name)
        }
      }
    }
    if (!register) fail(path, 'entrypoint must export a named register function')
  }

  function scanHelperCalls(node: Node | null | undefined, aliases = new Set<string>()) {
    if (!node) return
    if (isFunction(node)) {
      const inner = new Set(aliases)
      for (const parameter of node.params) {
        if (parameter.type === 'Identifier' && ['$', 'engine', 'host', 'next'].includes(parameter.name)) inner.add(parameter.name)
      }
      if (node.body.type === 'BlockStatement') {
        for (const statement of node.body.body) scanHelperCalls(statement, inner)
      } else scanHelperCalls(node.body, inner)
      return
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'Identifier' && aliases.has(node.init.name)) {
      aliases.add(node.id.name)
    }
    if (node.type === 'CallExpression') {
      const parts: string[] = []
      let cursor = node.callee
      while (cursor.type === 'MemberExpression' && !cursor.computed && !cursor.optional && cursor.property.type === 'Identifier') {
        parts.unshift(cursor.property.name)
        cursor = cursor.object
      }
      if (cursor.type === 'Identifier' && aliases.has(cursor.name)) {
        const call = parts.join('.')
        if (parts.length === 2 && !reserved.has(parts[0]!) && !reserved.has(parts[1]!)) helperCalls.add(call)
        else if (parts.length === 0) {
          const tier = node.arguments[1]
          if (tier?.type === 'Literal' && tiers.includes(tier.value)) helperTiers.add(tier.value)
        } else if (parts.length === 1 && parts[0] === 'to') {
          const tier = node.arguments[1]
          if (tier?.type === 'Literal' && tiers.includes(tier.value)) helperTiers.add(tier.value)
        }
      }
    }
    for (const child of children(node)) scanHelperCalls(child, aliases)
  }
  if (!entrypoint) scanHelperCalls(program)

  function bind(pattern: Node, bindings: Map<string, Role>) {
    if (pattern.type === 'Identifier') bindings.set(pattern.name, null)
    else if (pattern.type === 'RestElement') bind(pattern.argument, bindings)
    else if (pattern.type === 'AssignmentPattern') bind(pattern.left, bindings)
    else if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties) bind(prop.type === 'RestElement' ? prop.argument : prop.value, bindings)
    } else if (pattern.type === 'ArrayPattern') {
      for (const item of pattern.elements) if (item) bind(item, bindings)
    }
  }

  function blockScope(body: Node[], scope: Scope, event?: string): Scope {
    const bindings = new Map<string, Role>()
    for (const statement of body) {
      const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
      if (!node) continue
      if (node.type === 'VariableDeclaration') {
        for (const item of node.declarations) bind(item.id, bindings)
      } else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
        if (node.id) bindings.set(node.id.name, node === register ? 'register' : null)
      } else if (node.type === 'ImportDeclaration') {
        for (const item of node.specifiers) bindings.set(item.local.name, null)
      }
    }
    const inner = [...scope, bindings]
    // Pre-bind next results so closures declared before the const cannot hide escapes.
    for (const statement of body) {
      const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
      if (node?.type !== 'VariableDeclaration') continue
      for (const item of node.declarations) {
        if (item.init === register) bindings.set(item.id.name, 'register')
        const expression = item.init?.type === 'AwaitExpression' ? item.init.argument : item.init
        if (event === 'engine.create' && expression?.type === 'CallExpression' &&
          (roleOf(expression.callee, inner) === 'next' || (expression.callee.type === 'MemberExpression' && roleOf(expression.callee.object, inner) === 'next'))) {
          if (node.kind !== 'const' || item.id.type !== 'Identifier' || item.init.type !== 'AwaitExpression') {
            fail(path, 'engine.create next result requires const identifier = await next(input); aliases are unsupported')
          }
          bindings.set(item.id.name, 'beneath')
          engineNextBindings.add(expression)
        }
      }
    }
    return inner
  }

  function matcher(node: Node, nested = false, resolving = new Set<string>()) {
    if (node.type === 'Literal') {
      if (node.bigint !== undefined || (node.regex === undefined && node.value !== null && !['string', 'boolean', 'number'].includes(typeof node.value))) {
        fail(path, 'matcher contains an unsupported literal')
      }
      return
    }
    if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return
    if (node.type === 'Identifier') {
      if (importedBindings.has(node.name)) return
      const initializer = matcherConstants.get(node.name)
      if (!initializer || resolving.has(node.name)) fail(path, 'matcher identifiers must reference imported or declared static constants')
      const next = new Set(resolving)
      next.add(node.name)
      matcher(initializer, true, next)
      return
    }
    if (node.type === 'MemberExpression') {
      if (node.computed || node.optional || node.object.type !== 'Identifier' || !importedBindings.has(node.object.name) ||
        node.property.type !== 'Identifier' || reserved.has(node.property.name)) {
        fail(path, 'matcher members must reference static imported constants')
      }
      return
    }
    if (node.type === 'ArrayExpression') {
      for (const item of node.elements) {
        if (!item) fail(path, 'matcher arrays cannot contain holes')
        matcher(item.type === 'SpreadElement' ? item.argument : item, true, resolving)
      }
      return
    }
    if (node.type !== 'ObjectExpression') fail(path, 'matcher must be static data')
    const keys = new Set<string>()
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        matcher(property.argument, true, resolving)
        continue
      }
      const key = property.key?.name ?? property.key?.value
      if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init' || property.shorthand ||
        typeof key !== 'string' || reserved.has(key) || keys.has(key)) {
        fail(path, 'matcher supports only unique static fields')
      }
      keys.add(key)
      matcher(property.value, true, resolving)
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

  function visitFunction(node: Node, scope: Scope, roles: Role[] = [], event?: string) {
    if (roles.length && node.generator) fail(path, 'generator register/handlers are unsupported')
    const bindings = new Map<string, Role>()
    if (node.id) bindings.set(node.id.name, node === register ? 'register' : null)
    for (let i = 0; i < node.params.length; i++) {
      const param = node.params[i] as Node
      if ((roles[i] && param.type !== 'Identifier') || (roles.slice(i).some(Boolean) && param.type === 'RestElement')) fail(path, 'capability parameters must be simple identifiers (no destructuring/defaults/rest)')
      bind(param, bindings)
      if (roles[i]) bindings.set(param.name, roles[i]!)
    }
    const inner = [...scope, bindings]
    const outerReturningEngine = returningEngine
    returningEngine = event === 'engine.create' && roles[0] === 'engine'
    for (const param of node.params) visitPattern(param, inner, event)
    if (returningEngine && node.body.type !== 'BlockStatement') {
      visit({ type: 'ReturnStatement', argument: node.body }, inner, event)
    } else visit(node.body, inner, event)
    returningEngine = outerReturningEngine
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
    if (node.arguments.length === 3) matcher(node.arguments[1])
    const handler = node.arguments.at(-1) as Node
    if (!isFunction(handler)) fail(path, 'on handler must be an inline function; imported/aliased handlers are unsupported')
    events.add(event)
    visitFunction(handler, scope, ['engine', null, 'next'], event)
    return event
  }

  function capability(node: Node, scope: Scope): string | undefined {
    const parts: string[] = []
    let cursor = node
    let unsupported = false
    while (cursor.type === 'MemberExpression') {
      unsupported ||= Boolean(cursor.computed || cursor.optional || cursor.property.type !== 'Identifier')
      parts.unshift(cursor.property.name)
      cursor = cursor.object
    }
    const role = roleOf(cursor, scope)
    if (role !== 'engine' && role !== 'beneath') return
    if (unsupported || parts.length !== 2) fail(path, 'capabilities require static $.noun.method calls; computed/optional access and aliases are unsupported')
    const [noun, method] = parts as [string, string]
    if (reserved.has(noun) || reserved.has(method) || (coreNouns.has(noun) && !supportedCalls.has(`${noun}.${method}`) && !scanOnlyCalls.has(`${noun}.${method}`))) {
      fail(path, `unsupported core capability ${noun}.${method}`)
    }
    return `${noun}.${method}`
  }

  function visit(node: Node | null | undefined, scope: Scope, event?: string, standalone = false) {
    if (!node) return
    if (node === register) {
      if (!node.params.length) fail(path, 'register requires an on parameter')
      visitFunction(node, scope, ['on'])
      return
    }
    if (isFunction(node)) {
      visitFunction(node, scope, [], event)
      return
    }
    switch (node.type) {
      case 'Program': case 'BlockStatement': {
        const inner = blockScope(node.body, scope, event)
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
          visit(item.init, scope, event)
        }
        return
      case 'CatchClause': {
        const bindings = new Map<string, Role>()
        if (node.param) bind(node.param, bindings)
        visit(node.body, [...scope, bindings], event)
        return
      }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
        const declaration = node.init ?? node.left
        const inner = blockScope(declaration?.type === 'VariableDeclaration' ? [declaration] : [], scope)
        for (const child of children(node)) visit(child, inner, event)
        return
      }
      case 'SwitchStatement': {
        visit(node.discriminant, scope, event)
        const inner = blockScope(node.cases.flatMap((item: Node) => item.consequent), scope)
        for (const item of node.cases) {
          visit(item.test, inner, event)
          for (const statement of item.consequent) visit(statement, inner, event)
        }
        return
      }
      case 'Identifier':
        if (roleOf(node, scope)) fail(path, `capability alias/escape of ${node.name} is unsupported; do not pass capabilities to helpers`)
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
          visitFunction(node.arguments[0], scope, ['engine', null, 'next'], hookEvent)
          return
        }
        if (event === 'engine.create' && (roleOf(callee, scope) === 'next' ||
          (callee.type === 'MemberExpression' && roleOf(callee.object, scope) === 'next' && callee.property.name === 'to')) &&
          !engineNextBindings.has(node) && !engineReturns.has(node)) {
          fail(path, 'engine.create next result escape is unsupported; bind const identifier = await next(input)')
        }
        const call = capability(callee, scope)
        if (call) {
          if (node.optional) fail(path, 'optional capability calls are unsupported')
          calls.add(call)
        } else if (roleOf(callee, scope) === 'next') {
          if (node.optional || node.arguments.length !== 1) fail(path, 'next requires one input and a non-optional call')
        } else if (callee.type === 'MemberExpression' && roleOf(callee.object, scope) === 'next') {
          if (node.optional || callee.optional || callee.computed) fail(path, 'next supports only direct calls, next.is and literal next.to(input, tier)')
          if (callee.property.name === 'is') {
            if (node.arguments.length !== 2) fail(path, 'next.is requires a literal event and input')
            eventName(node.arguments[0])
            visit(node.arguments[1], scope, event)
            return
          }
          if (callee.property.name !== 'to') fail(path, 'next supports only direct calls, next.is and literal next.to(input, tier)')
          const tier = node.arguments[1]
          if (node.arguments.length !== 2 || tier?.type !== 'Literal' || !tiers.includes(tier.value)) fail(path, 'next.to tier must be a literal valid tier')
          nextTiers.add(tier.value)
        } else visit(callee, scope, event)
        const importedHelper = callee.type === 'Identifier' && importedBindings.has(callee.name)
        const capabilityIndexes: number[] = []
        node.arguments.forEach((argument: Node, index: number) => {
          if (importedHelper && roleOf(argument, scope) === 'next') {
            capabilityIndexes.push(index)
            return
          }
          visit(argument, scope, event)
        })
        if (importedHelper && capabilityIndexes.length) capabilityHelperCalls.push({ name: callee.name, indexes: capabilityIndexes })
        return
      }
      case 'MemberExpression':
        if (returningEngine && roleOf(node.object, scope) === 'beneath' && !node.computed && !node.optional && !reserved.has(node.property.name)) return
        if (roleOf(node.object, scope) === 'next' && !node.computed && !node.optional &&
          ['signal', 'event', 'origin', 'trace', 'error', 'called'].includes(node.property.name)) return
        visit(node.object, scope, event)
        if (node.computed) visit(node.property, scope, event)
        return
      case 'ReturnStatement': {
        const expression = node.argument?.type === 'AwaitExpression' ? node.argument.argument : node.argument
        if (returningEngine && expression?.type === 'CallExpression' && roleOf(expression.callee, scope) === 'next') engineReturns.add(expression)
        if (returningEngine && roleOf(node.argument ?? { type: '' }, scope) === 'beneath') return
        if (returningEngine && node.argument?.type === 'ObjectExpression') {
          for (const property of node.argument.properties) {
            if (property.type === 'SpreadElement' && roleOf(property.argument, scope) === 'beneath') continue
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
  visit(program, [])
  return { events, calls, nextTiers, helperCalls, helperTiers, helpersAcceptingNext, capabilityHelperCalls, topLevelAwait }
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
  const nextTiers = new Set<ModTier>()
  const seen = new Set<string>()
  const capabilityImports: { name: string; path: string; indexes: number[] }[] = []
  const importedCapabilities = new Map<string, Set<number>>()
  const importedHelperCalls = new Set<string>()
  const importedHelperTiers = new Set<ModTier>()
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
  async function load(path: string) {
    if (seen.has(path)) return
    if (!within(root, path)) fail(path, 'path is outside plugin root')
    const actual = await realpath(path)
    if (!within(rootReal, actual)) fail(path, 'realpath is outside plugin root')
    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'].includes(extname(path))) fail(path, 'only TS/JS ESM files are supported')
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
    modules.push({ path, source: compiled })
    const scanned = scan(program, path, entrypoints.includes(path))
    if (scanned.topLevelAwait) awaits.add(path)
    for (const value of scanned.events) events.add(value)
    for (const value of scanned.calls) calls.add(value)
    for (const value of scanned.nextTiers) nextTiers.add(value)
    for (const value of scanned.helperCalls) importedHelperCalls.add(value)
    for (const value of scanned.helperTiers) importedHelperTiers.add(value)
    for (const [name, indexes] of scanned.helpersAcceptingNext) {
      const existing = importedCapabilities.get(name)
      if (existing) for (const index of indexes) existing.add(index)
      else importedCapabilities.set(name, new Set(indexes))
    }
    for (const value of scanned.capabilityHelperCalls) capabilityImports.push({ ...value, path })
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
      const requested = resolve(path, '..', specifier)
      if (!within(root, requested)) fail(path, `import is outside plugin root: ${specifier}`)
      const extension = extname(requested)
      const emittedExtension = extension === '.js' ? ['.ts', '.tsx'] : extension === '.jsx' ? ['.tsx'] : []
      const direct = extension ? [requested, ...emittedExtension.map(value => requested.slice(0, -extension.length) + value)] :
        [requested, ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'].map(value => requested + value)]
      const candidates = [...direct, ...direct.flatMap(candidate =>
        ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'].map(value => resolve(candidate, `index${value}`)),
      )]
      let to: string | undefined
      for (const candidate of candidates) {
        try {
          const metadata = await stat(candidate)
          if (metadata.isFile()) { to = candidate; break }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
        }
      }
      if (!to) fail(path, `cannot resolve relative import ${specifier}`)
      links.push({ from: path, specifier, to })
      await load(to)
    }
  }
  for (const path of entrypoints) await load(path)
  for (const link of links) {
    if (awaits.has(link.to)) fail(link.to, 'top-level await in imported files is unsupported')
  }
  for (const call of importedHelperCalls) {
    if (supportedCalls.has(call) || scanOnlyCalls.has(call) || !coreNouns.has(call.split('.')[0]!)) calls.add(call)
  }
  for (const value of importedHelperTiers) nextTiers.add(value)
  for (const helper of capabilityImports) {
    const indexes = importedCapabilities.get(helper.name)
    if (!indexes || helper.indexes.some(index => !indexes.has(index))) {
      fail(helper.path, `passing capabilities to imported helper ${helper.name} is unsupported; helpers must declare a conventional engine/next parameter in that argument position`)
    }
  }
  const relativePath = (path: string) => relative(root, path).split(sep).join('/')
  // Absolute installation locations are plumbing, not declaration identity.
  const fingerprint = createHash('sha256').update(JSON.stringify({
    entrypoints: entrypoints.map(relativePath),
    modules: modules.map(module => ({ path: relativePath(module.path), source: module.source })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    options, tier,
  })).digest('hex')
  return {
    name: input.name, storageId: input.storageId, pluginRoot: root,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.isNative === true ? { isNative: true } : {}),
    entrypoints, modules, links, events: [...events], calls: [...calls].sort(),
    nextTiers: tiers.filter(value => nextTiers.has(value)), options, tier, fingerprint,
  }
}
