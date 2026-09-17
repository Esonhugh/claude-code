// Executed inside each Mod VM: constructors and closures never become host globals.
export function createModUiRealm(plugin: string, isProxy: (value: unknown) => boolean) {
  type Props = Record<string, unknown>
  type Node = { type: string; props?: Props; children?: unknown[]; [key: string]: unknown }
  type Callback = (event: Props) => unknown
  type Constructor = (props?: Props) => Node
  const callbacks = new WeakMap<object, Callback>()

  function ownProps(value: unknown): Props {
    if (value === null || value === undefined) return {}
    if (typeof value !== 'object' || isProxy(value) || Array.isArray(value)) throw new Error('Element props must be a non-proxy object')
    const result: Props = {}
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) throw new Error('Element accessors are unsupported')
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: true, configurable: true })
    }
    return result
  }

  function childrenOf(value: unknown, path = new Set<object>()): unknown[] {
    if (isProxy(value)) throw new Error('UI proxies are unsupported')
    if (value === null || value === undefined || typeof value === 'boolean') return []
    if (Array.isArray(value)) {
      if (path.has(value) || path.size >= 100) throw new Error('Cyclic or excessive UI children')
      path.add(value)
      const children: unknown[] = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index)
        if (descriptor && !('value' in descriptor)) throw new Error('Element accessors are unsupported')
        children.push(...childrenOf(descriptor?.value, path))
      }
      path.delete(value)
      return children
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Invalid element child')
      return [String(value)]
    }
    if (typeof value !== 'string' && typeof value !== 'object') throw new Error('Invalid element child')
    return [value]
  }

  function element(type: string): Constructor {
    return Object.freeze((value: Props = {}) => {
      const props = ownProps(value)
      const children = childrenOf(props.children)
      const hover = props.hover
      const handlers = { press: props.onPress, input: props.onInput, submit: props.onSubmit, select: props.onSelect }
      delete props.children
      delete props.hover
      delete props.onPress
      delete props.onInput
      delete props.onSubmit
      delete props.onSelect
      let callback: Callback | undefined
      if (type === 'Button') {
        const label = props.label ?? (children.length === 1 && typeof children[0] === 'string' ? children[0] : undefined)
        if (typeof label !== 'string') throw new Error('Button requires a label')
        props.label = label
        props.key ??= label
        if (typeof handlers.press !== 'function') throw new Error('Button requires an onPress callback')
        const press = handlers.press as () => unknown
        callback = () => press()
      } else if (type === 'Select') {
        if (typeof handlers.select !== 'function') throw new Error('Select requires an onSelect callback')
        const select = handlers.select as (value: unknown, event: Props) => unknown
        callback = event => select(event.value, event)
      } else if (type === 'Input') {
        if ((handlers.input !== undefined && typeof handlers.input !== 'function') ||
          typeof handlers.submit !== 'function') throw new Error('Input requires onSubmit and callable callbacks')
        const input = handlers.input as ((value: unknown, event: Props) => unknown) | undefined
        const submit = handlers.submit as (value: unknown, event: Props) => unknown
        callback = event => event.kind === 'submit'
          ? submit(event.value, event)
          : input?.(event.value, event)
      }
      const node: Node = { type, props: Object.freeze(props) }
      if (['Box', 'Text', 'Link'].includes(type)) node.children = Object.freeze(children) as unknown as unknown[]
      if (hover !== undefined) node.hover = Object.freeze(ownProps(hover))
      if (props.key !== undefined || callback ||
          (node.hover as Props | undefined)?.scope !== undefined)
        node.group = Object.freeze({ plugin })
      if (callback) {
        node.press = Object.freeze({ plugin, handle: 0 })
        callbacks.set(node, callback)
      }
      return Object.freeze(node)
    })
  }

  const terminal = Object.freeze(Object.fromEntries(
    ['Box', 'Text', 'Button', 'Input', 'Select', 'Link', 'Code'].map(name => [name, element(name)]),
  )) as Readonly<Record<string, Constructor>>
  const Fragment = Object.freeze((props: Props = {}) => terminal.Box!({ flexDirection: 'column', children: props.children }))
  const h = Object.freeze((tag: unknown, props: unknown, ...children: unknown[]) => {
    if (typeof tag !== 'function') throw new Error('JSX requires an element constructor')
    const input = ownProps(props)
    return tag({ ...input, ...(children.length ? { children } : {}) })
  })

  // Only a drawing owns callback handles. Cached, undrawn trees hold no host
  // resources; forwarding a downstream drawing preserves its existing handles.
  function materialize(value: unknown, keep: (callback: Callback) => number): unknown {
    const drawn = new WeakMap<object, unknown>()
    const path = new Set<object>()
    function visit(value: unknown): unknown {
      if (isProxy(value)) throw new Error('UI proxies are unsupported')
      if (!value || typeof value !== 'object') return value
      if (path.has(value)) throw new Error('Cyclic UI drawing')
      if (path.size >= 100) throw new Error('Excessive UI drawing depth')
      if (drawn.has(value)) return drawn.get(value)
      path.add(value)
      const array = Array.isArray(value)
      const result: Record<string, unknown> | unknown[] = array ? [] : {}
      let changed = false
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !('value' in descriptor)) throw new Error('Element accessors are unsupported')
        const child = visit(descriptor.value)
        changed ||= child !== descriptor.value
        Object.defineProperty(result, key, { value: child, enumerable: true, configurable: true })
      }
      if (array) (result as unknown[]).length = value.length
      const callback = callbacks.get(value)
      if (callback) {
        Object.defineProperty(result, 'press', { value: Object.freeze({ plugin, handle: keep(callback) }), enumerable: true })
        changed = true
      }
      path.delete(value)
      const output = changed ? Object.freeze(result) : value
      drawn.set(value, output)
      return output
    }
    return visit(value)
  }

  return Object.freeze({
    h, Fragment, materialize,
    resolve: Object.freeze((input: Props) => {
      if (input.surface !== 'terminal') throw new Error('This host only provides terminal UI elements')
      return terminal
    }),
  })
}
