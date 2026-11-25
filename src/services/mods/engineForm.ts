// The one form official 2.1.329 reads an engine.create hook in, so validate can list what it adds to and
// withholds from $. A hook outside the form still loads; validate refuses it and lists nothing.
type Node = { type: string; [key: string]: any }

export type EngineFormRefusal = { file: string; line?: number; part: string }
export type EngineForm =
  | { isInForm: true; added: string[]; addedUnlessThere: string[]; withheld: string[] | 'everything' }
  | ({ isInForm: false } & EngineFormRefusal)

class OutsideForm extends Error {
  constructor(readonly node: Node | undefined, readonly part: string) { super(part) }
}

const reads = new Set(['budget', 'event', 'is', 'origin', 'signal', 'trace'])
const pluginReads = new Set(['name', 'root'])
const notValues = new Set(['undefined', 'NaN', 'Infinity'])
const mutators = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'])

const isFunction = (node: Node | undefined) =>
  node?.type === 'FunctionDeclaration' || node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression'
const ownsParams = (parent: Node, node: Node) => parent.id === node || parent.params.includes(node)
const declares: Record<string, (parent: Node, node: Node, grandparent: Node | undefined) => boolean> = {
  VariableDeclarator: (parent, node) => parent.id === node,
  FunctionDeclaration: ownsParams,
  FunctionExpression: ownsParams,
  ArrowFunctionExpression: (parent, node) => parent.params.includes(node),
  ClassDeclaration: (parent, node) => parent.id === node,
  ClassExpression: (parent, node) => parent.id === node,
  CatchClause: (parent, node) => parent.param === node,
  AssignmentPattern: (parent, node) => parent.left === node,
  RestElement: (parent, node) => parent.argument === node,
  ArrayPattern: (parent, node) => parent.elements.includes(node),
  Property: (parent, node, grandparent) => parent.value === node && grandparent?.type === 'ObjectPattern',
  ImportSpecifier: (parent, node) => parent.local === node,
  ImportDefaultSpecifier: (parent, node) => parent.local === node,
  ImportNamespaceSpecifier: (parent, node) => parent.local === node,
}
const isDeclaration = (node: Node, parent?: Node, grandparent?: Node) =>
  parent !== undefined && (declares[parent.type]?.(parent, node, grandparent) ?? false)
const notReads = new Set(['LabeledStatement', 'BreakStatement', 'ContinueStatement', 'ExportSpecifier', 'ImportSpecifier',
  'ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'MetaProperty', 'ExportAllDeclaration', 'ImportAttribute'])
const isRead = (node: Node, parent?: Node, grandparent?: Node) =>
  !isDeclaration(node, parent, grandparent) &&
  !(parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) &&
  !((parent?.type === 'Property' || parent?.type === 'PropertyDefinition' || parent?.type === 'MethodDefinition') && parent.key === node && !parent.computed) &&
  !notReads.has(parent?.type ?? '')

function walk(root: Node, visit: (node: Node, parent?: Node, grandparent?: Node) => void, skip?: (node: Node) => boolean) {
  const stack: { node: Node; parent?: Node; grandparent?: Node }[] = [{ node: root }]
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    visit(item.node, item.parent, item.grandparent)
    if (skip?.(item.node)) continue
    const keys = Object.keys(item.node)
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!
      if (key === 'loc' || key === 'type' || key === 'start' || key === 'end') continue
      const value = item.node[key]
      const values = Array.isArray(value) ? value : [value]
      for (let j = values.length - 1; j >= 0; j--) {
        const child = values[j]
        if (typeof child === 'object' && child !== null && typeof child.type === 'string') stack.push({ node: child, parent: item.node, grandparent: item.parent })
      }
    }
  }
}

function references(root: Node, name: string, own = false): Node[] {
  const found: Node[] = []
  walk(root, (node, parent, grandparent) => {
    if (node.type === 'Identifier' && node.name === name && isRead(node, parent, grandparent)) found.push(node)
  }, own ? node => node !== root && (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') : undefined)
  return found
}

function declarations(root: Node, name: string): Node[] {
  const found: Node[] = []
  walk(root, (node, parent, grandparent) => {
    if (node.type === 'Identifier' && node.name === name && isDeclaration(node, parent, grandparent)) found.push(node)
  })
  return found
}

// A name as validate lists it: bare when it is one, else quoted, cut at 100 characters.
export function engineKeyName(name: string): string {
  const spelled = /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'nothing' && name !== 'everything' ? name :
    `"${name.replace(/["\\]/g, '\\$&').replace(/[^\x20-\x7e]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`
  if (spelled.length <= 100) return spelled
  const cut = `${spelled.slice(0, 100)}\u2026 [+${spelled.length - 100} chars]`
  return spelled.startsWith('"') ? `${cut}"` : cut
}

function analyze(hook: Node, parentOf: (node: Node) => Node | undefined) {
  const refuse = (node: Node | undefined, part: string): never => { throw new OutsideForm(node, part) }
  const parameterNames = () => new Set<string>(hook.params.flatMap((param: Node) => param.type === 'Identifier' ? [param.name] : []))
  const plainMember = (node: Node | undefined, object: Node) =>
    node?.type === 'MemberExpression' && node.object === object && !node.computed && !node.optional
  const declaredOnce = (binding: Node) => {
    const [again] = declarations(hook, binding.name).filter(node => node !== binding)
    if (again !== undefined) refuse(again, `"${binding.name}" declared a second time in the hook`)
  }
  const isWrite = (node: Node) => {
    let target = node
    for (let parent = parentOf(target); parent?.type === 'ChainExpression' || (parent?.type === 'MemberExpression' && parent.object === target); parent = parentOf(target)) target = parent
    const parent = parentOf(target)
    switch (parent?.type) {
      case 'AssignmentExpression': case 'AssignmentPattern': case 'ForInStatement': case 'ForOfStatement': return parent.left === target
      case 'UpdateExpression': case 'ArrayPattern': case 'RestElement': return true
      case 'UnaryExpression': return parent.operator === 'delete'
      case 'Property': return parent.value === target && parentOf(parent)?.type === 'ObjectPattern'
      case 'CallExpression': return parent.callee === target && target.type === 'MemberExpression' && !target.computed &&
        target.property.type === 'Identifier' && mutators.has(target.property.name)
      default: return false
    }
  }
  const inNestedFunction = (node: Node) => {
    const parent = parentOf(node)
    const named = parent?.type === 'FunctionDeclaration' && parent.id === node
    for (let at = named ? parentOf(parent) : parent; at !== undefined && at !== hook; at = parentOf(at)) if (isFunction(at)) return true
    return false
  }
  const valueOk = (node: Node, names: Set<string>): boolean => {
    switch (node.type) {
      case 'ObjectExpression': case 'CallExpression': case 'NewExpression': return true
      case 'MemberExpression': {
        let root = node
        while (root.type === 'MemberExpression') root = root.object
        return root.type !== 'Identifier' || !names.has(root.name)
      }
      case 'Identifier': return !notValues.has(node.name) && !names.has(node.name)
      case 'AwaitExpression': return valueOk(node.argument, names)
      default: return false
    }
  }
  const keyOf = (property: Node): string => {
    if (property.computed) refuse(property, 'a computed key')
    if (property.kind !== 'init') refuse(property, 'an accessor')
    if (property.method) refuse(property, 'a method')
    const { key } = property
    const name = key.type === 'Identifier' ? key.name : key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined
    if (name === undefined) refuse(property, 'a key that is not a plain name')
    if (name === '__proto__') refuse(property, 'a __proto__ key')
    if (name === 'then') refuse(property, 'a then key')
    return name!
  }
  const written = (object: Node, isBeneath: (node: Node) => boolean, names: Set<string>) => {
    const added: string[] = []
    const addedUnlessThere: string[] = []
    const keys = new Set<string>()
    const spread = object.properties.findIndex((property: Node) => property.type === 'SpreadElement')
    object.properties.forEach((property: Node, index: number) => {
      if (property.type === 'SpreadElement') {
        if (!isBeneath(property.argument)) refuse(property, 'a spread of anything but the value of next(e)')
        if (index !== spread) refuse(property, 'a spread of the value of next(e) more than once')
        return
      }
      const key = keyOf(property)
      if (keys.has(key)) refuse(property, `the key ${engineKeyName(key)} written twice`)
      keys.add(key)
      if (!valueOk(property.value, names)) refuse(property.value, `the value of ${engineKeyName(key)}, which is not an object, a name or a call`)
      ;(index < spread ? addedUnlessThere : added).push(key)
    })
    return { added, addedUnlessThere }
  }

  if (hook.generator) refuse(hook, 'a generator')
  if (hook.params.length > 3) refuse(hook, 'a hook with more than ($, e, next)')
  for (const param of hook.params) if (param.type !== 'Identifier') refuse(param, 'a parameter that is not a plain name')
  const [dynamic] = [...references(hook, 'arguments', true), ...references(hook, 'eval')]
  if (dynamic !== undefined) refuse(dynamic, `a use of ${dynamic.name}`)
  const [, event, next] = hook.params as (Node | undefined)[]
  if (event !== undefined) {
    const [again] = declarations(hook, event.name).filter(node => node !== event && !inNestedFunction(node))
    if (again !== undefined) refuse(again, `"${event.name}" declared a second time in the hook`)
    for (const node of references(hook, event.name)) if (isWrite(node)) refuse(node, `a write to ${event.name}`)
  }
  const returned = returnOf(hook, refuse)
  if (event === undefined || next === undefined) {
    if (returned.type !== 'ObjectExpression') refuse(returned, 'a hook with no next that returns anything but an object literal')
    return { ...written(returned, () => false, parameterNames()), withheld: 'everything' as const }
  }

  const isCall = (node: Node | undefined) => node?.type === 'CallExpression' && !node.optional && node.callee.type === 'Identifier' &&
    node.callee.name === next.name && node.arguments.length === 1 && node.arguments[0]?.type === 'Identifier' && node.arguments[0].name === event.name
  const isAwaited = (node: Node) => node.type === 'AwaitExpression' && isCall(node.argument)
  declaredOnce(next)
  const [call, again] = references(hook, next.name).filter(node => {
    const parent = parentOf(node)
    return !(parent?.type === 'MemberExpression' && parent.object === node && !parent.computed && parent.property.type === 'Identifier' && reads.has(parent.property.name))
  })
  if (call === undefined) refuse(next, 'a next parameter the hook never calls')
  if (again !== undefined) refuse(again, `${next.name} called or used more than once`)
  const called = parentOf(call!)
  if (!isCall(called)) refuse(call, `${next.name} used as anything but ${next.name}(${event.name})`)
  const bound = boundBeneath(isAwaited)
  const isBeneath = bound ? (node: Node) => node.type === 'Identifier' && node.name === bound.name : isAwaited
  if (bound === undefined && !inReturn(called!)) refuse(call, `${next.name}(${event.name}) anywhere but as await ${next.name}(${event.name}) in the hook's one const or its return`)
  if (bound !== undefined) {
    const name = engineKeyName(bound.name)
    for (const node of references(hook, bound.name)) {
      const parent = parentOf(node)
      if (node !== returned && !(parent?.type === 'SpreadElement' && parentOf(parent) === returned) && !isNounCall(node))
        refuse(node, `a use of ${name} other than the return, ${name}.noun.event(...), ${name}.plugin.root and ${name}.plugin.name`)
    }
  }
  const withheld = bound?.withheld ?? []
  if (isBeneath(returned) || (bound === undefined && isCall(returned))) return { added: [], addedUnlessThere: [], withheld }
  if (returned.type !== 'ObjectExpression') refuse(returned, 'a return of anything but the forms above')
  const names = parameterNames()
  if (bound !== undefined) names.add(bound.name)
  const keys = written(returned, isBeneath, names)
  if (!returned.properties.some((property: Node) => property.type === 'SpreadElement'))
    refuse(returned, 'a return with no spread of the value of next(e); to withhold everything, leave next out of the parameters')
  const [both] = [...keys.added, ...keys.addedUnlessThere].filter(key => withheld.includes(key))
  if (both !== undefined) refuse(returned, `${engineKeyName(both)} both withheld and written`)
  return { ...keys, withheld }

  function inReturn(node: Node) {
    const parent = parentOf(node)
    if (node === returned || parent?.type !== 'AwaitExpression') return node === returned
    const grandparent = parentOf(parent)
    return parent === returned || (grandparent?.type === 'SpreadElement' && parentOf(grandparent) === returned)
  }
  // The hook's one const bound to await next(e): a name, or a destructure of plain keys and a plain rest.
  function boundBeneath(isAwaited: (node: Node) => boolean): { name: string; withheld: string[] } | undefined {
    if (hook.body.type !== 'BlockStatement') return
    for (const statement of hook.body.body) {
      if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const' || statement.declarations.length !== 1) continue
      const [declarator] = statement.declarations
      if (!declarator?.init || !isAwaited(declarator.init)) continue
      const { id } = declarator
      if (id.type === 'Identifier') {
        declaredOnce(id)
        return { name: id.name, withheld: [] }
      }
      if (id.type !== 'ObjectPattern') refuse(id, 'a binding of next(e) that is not a name or a destructure')
      const rest = id.properties.at(-1)
      if (rest?.type !== 'RestElement' || rest.argument.type !== 'Identifier') refuse(id, 'a destructure of next(e) with no plain rest')
      declaredOnce(rest.argument)
      const keys = id.properties.slice(0, -1).map((property: Node) => {
        if (property.type !== 'Property' || property.computed || !property.shorthand || property.key.type !== 'Identifier' ||
          property.value.type !== 'Identifier' || property.key.name === '__proto__')
          refuse(property, 'a key in the destructure of next(e) that is not a plain name')
        declaredOnce(property.value)
        const [read] = references(hook, property.value.name)
        if (read !== undefined) refuse(read, `a read of ${read.name}, which the hook withholds`)
        return property.key.name as string
      })
      return { name: rest.argument.name, withheld: keys }
    }
  }
  // below.noun.event(...) called, or below.plugin.root and below.plugin.name read.
  function isNounCall(node: Node) {
    const noun = parentOf(node)
    const member = noun && parentOf(noun)
    if (!plainMember(noun, node) || !plainMember(member, noun!) || noun!.property.type !== 'Identifier' || member!.property.type !== 'Identifier') return false
    const use = parentOf(member!)
    if (noun!.property.name !== 'plugin')
      return noun!.property.name !== '__proto__' && member!.property.name !== '__proto__' && use?.type === 'CallExpression' && use.callee === member && !use.optional
    return pluginReads.has(member!.property.name) && !isWrite(node) && !usesAsObject(member!, use)
  }
  function usesAsObject(node: Node, use: Node | undefined) {
    switch (use?.type) {
      case 'MemberExpression': return use.object === node
      case 'TaggedTemplateExpression': return use.tag === node
      case 'CallExpression': case 'NewExpression': return use.callee === node
      case 'VariableDeclarator': return use.id.type !== 'Identifier'
      case 'AssignmentExpression': return use.right === node && use.left.type !== 'Identifier'
      default: return false
    }
  }
}

// The value the hook returns: its expression body, or the one return that ends its block.
function returnOf(hook: Node, refuse: (node: Node | undefined, part: string) => never): Node {
  const { body } = hook
  if (body.type !== 'BlockStatement') return body
  const returns: Node[] = []
  walk(body, node => { if (node.type === 'ReturnStatement') returns.push(node) }, isFunction)
  const last = body.body.at(-1)
  const [early] = returns.filter(node => node !== last)
  if (early !== undefined) refuse(early, "a return that is not the one last statement of the hook's body")
  if (last?.type !== 'ReturnStatement') refuse(last ?? body, "a hook whose last statement is not its return")
  if (!last.argument) refuse(last, 'a return with no value')
  return last.argument
}

function hookFunction(program: Node, name: string): Node | undefined {
  for (const statement of program.body) {
    const node = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement
    if (node?.type === 'FunctionDeclaration' && node.id?.name === name) return node
    if (node?.type !== 'VariableDeclaration' || node.kind !== 'const') continue
    for (const { id, init } of node.declarations)
      if (id.type === 'Identifier' && id.name === name && (init?.type === 'FunctionExpression' || init?.type === 'ArrowFunctionExpression')) return init
  }
}

/**
 * The engine.create hook of an entry file read in its one form, as official 2.1.329's validate does;
 * undefined when the file registers none, or names its hook in a way only the loader judges.
 */
export function engineFormOf(program: Node, file: string): EngineForm | undefined {
  const register = hookFunction(program, 'register')
  const on = register?.params[0]
  if (register === undefined || on?.type !== 'Identifier') return
  const parents = new Map<Node, Node>()
  walk(program, (node, parent) => { if (parent !== undefined) parents.set(node, parent) })
  const parentOf = (node: Node) => parents.get(node)
  const registrations: Node[] = []
  walk(register.body, node => {
    const [event] = node.type === 'CallExpression' ? node.arguments : []
    if (node.callee?.type === 'Identifier' && node.callee.name === on.name && event?.type === 'Literal' && event.value === 'engine.create') registrations.push(node)
  })
  const [first, second] = registrations
  if (first === undefined) return
  const refused = (node: Node | undefined, part: string): EngineForm => ({ isInForm: false, file, line: node?.loc?.start.line, part })
  try {
    if (second !== undefined) return refused(second, 'a second engine.create hook')
    if (first.arguments.length > 2) return refused(first.arguments[1], 'a matcher on the hook')
    const hook = first.arguments.at(-1)
    const fn = hook?.type === 'Identifier' ? hookFunction(program, hook.name) : hook
    if (hook?.type === 'Identifier' && fn === undefined) return
    if (fn?.type !== 'FunctionExpression' && fn?.type !== 'ArrowFunctionExpression' && fn?.type !== 'FunctionDeclaration')
      return refused(first, 'a hook that is not a function, inline or by name')
    return { isInForm: true, ...analyze(fn, parentOf) }
  } catch (error) {
    if (!(error instanceof OutsideForm)) throw error
    return refused(error.node, error.part)
  }
}

export const engineFormSpelling = "Spell it one way: on('engine.create', async ($, e, next) => { const { fs, process, ...beneath } = await next(e); /* any statements that don't return */ return { ...beneath, voice: voiceOf() } }). Validate lists what a hook in this form does if it registers and doesn't throw. It can't say what this module adds to or withholds from $."

// What validate lists for a hook in form: core nouns (and $.plugin) it adds are replacements, which the fold refuses.
export function engineFormNotes(form: EngineForm | undefined, core: ReadonlySet<string>): string[] {
  if (form?.isInForm === false) return []
  const added = form?.added ?? []
  const unlessThere = form?.addedUnlessThere ?? []
  const withheld = form === undefined ? [] : form.withheld === 'everything' ? ['everything beneath it'] : form.withheld.filter(name => name !== 'plugin').map(engineKeyName)
  const adds = added.filter(name => name !== 'plugin' && !core.has(name)).map(engineKeyName)
  const replaces = added.filter(name => name === 'plugin' || core.has(name)).map(engineKeyName)
  return [
    ...(adds.length ? [`adds to $: ${adds.join(', ')}`] : unlessThere.length ? [] : ['adds to $: nothing']),
    ...(unlessThere.length ? [`adds to $ unless it's there: ${unlessThere.map(engineKeyName).join(', ')}`] : []),
    withheld.length ? `withholds from $: ${withheld.join(', ')} (in the user or builtin tier, the fold refuses this and unloads the module)` : 'withholds from $: nothing',
    ...(replaces.length ? [`replaces on $: ${replaces.join(', ')} (the fold refuses this and unloads the module)`] : []),
  ]
}
