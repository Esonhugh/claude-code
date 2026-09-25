import { isDeepStrictEqual } from 'node:util'
import type { ModInput } from './types.js'

export type ModUiOwner = object
export type ModUiOrigin =
  | { kind: 'person' }
  | { kind: 'plugin'; name?: string }
  | { kind: 'unload' }

export type ModUiPresentation = {
  columns: number
  rows: number
  isFullscreen: boolean
  composerEmpty: boolean
  hasDialog: boolean
  keyboardOwned: boolean
  agentId?: string
}

export type ModUiOpenArgs = {
  id: string
  title?: string
  focus?: true
  closeOnEscape?: true
  holdToasts?: true
  rows?: number
}

export type ModUiCallback = { plugin: string; handle: number }
export type ModUiInteraction =
  | 'press'
  | 'input.change'
  | 'input.submit'
  | 'select'
export type ModUiPlacement = 'dock' | 'inline'
export type ModUiKeyRow = {
  plugin: string
  key: string
  top: number
  bottom: number
}

export type ModUiPane = {
  id: string
  title: string
  plugin: string
  owner: ModUiOwner
  visible: boolean
  placement: ModUiPlacement
  focused: boolean
  closeOnEscape: boolean
  holdToasts: boolean
  rows?: number
  scrollOffset: number
  bodyRows: number
  bodyColumns: number
  revision: number
  contentRows: number
  focusedElement?: string
  tree?: unknown
  drawing?: number
}

export type ModUiDispatch = (
  owner: ModUiOwner,
  event: string,
  input: ModInput,
  core: (input: ModInput) => Promise<unknown>,
  options: {
    origin?: ModUiOrigin
    skipOwner?: ModUiOwner
    restoreInput?: (rewritten: ModInput, received: ModInput) => ModInput
  },
) => Promise<unknown>

export type ModUi = {
  open(
    owner: ModUiOwner,
    pane: ModUiOpenArgs,
    origin: Exclude<ModUiOrigin, { kind: 'unload' }>,
    presentation: ModUiPresentation,
  ): Promise<unknown>
  close(owner: ModUiOwner, id: string, origin: ModUiOrigin): Promise<unknown>
  blit(owner: ModUiOwner, input: {
    requestId: string
    key: string
    cells?: string
    source?: unknown
    columns?: number
    rows?: number
  }): Promise<unknown>
  invalidate(owner: ModUiOwner, event: string): Promise<void>
  render(presentation: ModUiPresentation): Promise<void>
  scroll(
    owner: ModUiOwner,
    input: {
      requestId: string
      by: number
      origin: Exclude<ModUiOrigin, { kind: 'unload' }>
      pointer?: { column: number; row: number }
    },
  ): Promise<unknown>
  focus(
    owner: ModUiOwner,
    input: {
      requestId: string
      element?: string
      origin: Exclude<ModUiOrigin, { kind: 'unload' }>
    },
    presentation?: ModUiPresentation,
  ): Promise<unknown>
  reveal(
    owner: ModUiOwner,
    input: {
      requestId?: string
      targetRequestId?: string
      key?: string
      edge?: 'start' | 'end'
      block?: 'start' | 'center' | 'end' | 'nearest'
      origin: Extract<ModUiOrigin, { kind: 'plugin' }>
    },
  ): Promise<unknown>
  interact(
    id: string,
    drawing: number,
    callback: ModUiCallback,
    kind: ModUiInteraction,
    element: string,
    value?: string,
  ): Promise<unknown>
  reportMetrics(id: string, metrics: {
    bodyRows: number
    contentRows: number
    keyRows?: readonly ModUiKeyRow[]
  }): void | Promise<void>
  prepareCommit(owner: ModUiOwner, replacedOwner?: ModUiOwner, preparedOwners?: readonly ModUiOwner[]): Promise<() => Promise<void>>
  commit(owner: ModUiOwner, replacedOwner?: ModUiOwner): Promise<void>
  releaseCandidate(owner: ModUiOwner): void
  release(owner: ModUiOwner): Promise<void>
  getSnapshot(): readonly ModUiPane[]
  subscribe(listener: () => void): () => void
}

type PaneState = Omit<ModUiPane, 'bodyColumns' | 'revision'> & {
  presentation: ModUiPresentation
  personInitiated: boolean
  drawGeneration: number
  measuredBodyRows?: number
  keyRows: readonly ModUiKeyRow[]
}

type BlitFrame = {
  apply(): unknown | Promise<unknown>
  waiters: ReturnType<typeof Promise.withResolvers<unknown>>[]
}

const idPattern = /^[A-Za-z0-9_-]{1,64}$/
const invalidatableRenderEvent = 'ui.render'

function validateOwner(owner: ModUiOwner): void {
  if ((typeof owner !== 'object' && typeof owner !== 'function') || owner === null)
    throw new TypeError('Mod UI owner must be an activation object')
}

function validatePresentation(input: ModUiPresentation): ModUiPresentation {
  if (!input || typeof input !== 'object')
    throw new TypeError('Mod UI presentation must be an object')
  for (const key of ['columns', 'rows'] as const) {
    if (!Number.isInteger(input[key]) || input[key] < 1)
      throw new TypeError(`Mod UI presentation ${key} must be a positive integer`)
  }
  for (const key of ['isFullscreen', 'composerEmpty', 'hasDialog', 'keyboardOwned'] as const) {
    if (typeof input[key] !== 'boolean')
      throw new TypeError(`Mod UI presentation ${key} must be boolean`)
  }
  if (input.agentId !== undefined && typeof input.agentId !== 'string')
    throw new TypeError('Mod UI presentation agentId must be a string')
  return Object.freeze({ ...input })
}

function copyOpen(input: ModUiOpenArgs, expectedId?: string): Readonly<ModUiOpenArgs> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('Mod UI pane must be an object')
  if (typeof input.id !== 'string' || !idPattern.test(input.id))
    throw new TypeError('Mod UI pane id must use 1-64 letters, digits, underscores, or dashes')
  if (expectedId !== undefined && input.id !== expectedId)
    throw new TypeError('Mod UI hooks cannot rename a pane')
  if (input.title !== undefined && (typeof input.title !== 'string' || /[\r\n]/.test(input.title)))
    throw new TypeError('Mod UI pane title must be a single line string')
  for (const key of ['focus', 'closeOnEscape', 'holdToasts'] as const) {
    if (input[key] !== undefined && input[key] !== true)
      throw new TypeError(`Mod UI pane ${key} may only be true`)
  }
  if (input.rows !== undefined && (!Number.isInteger(input.rows) || input.rows < 1))
    throw new TypeError('Mod UI pane rows must be a positive whole number')
  return Object.freeze({
    id: input.id,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.focus === true ? { focus: true as const } : {}),
    ...(input.closeOnEscape === true ? { closeOnEscape: true as const } : {}),
    ...(input.holdToasts === true ? { holdToasts: true as const } : {}),
    ...(input.rows === undefined ? {} : { rows: input.rows }),
  })
}

function validateCallback(callback: ModUiCallback): void {
  if (
    !callback ||
    typeof callback !== 'object' ||
    typeof callback.plugin !== 'string' ||
    !Number.isInteger(callback.handle) ||
    callback.handle < 1
  ) {
    throw new TypeError('Mod UI callback must carry a plugin and positive drawing handle')
  }
}

export function createModUi({
  notify = listener => listener(),
  pluginOf,
  dispatch,
  draw,
  invokeDrawing,
  releaseDrawing,
  validateTree,
}: {
  notify?: (listener: () => void) => void
  pluginOf(owner: ModUiOwner): string
  dispatch: ModUiDispatch
  draw(owner: ModUiOwner, input: ModInput, drawing: number): Promise<unknown>
  invokeDrawing(
    owner: ModUiOwner,
    drawing: number,
    handle: number,
    args: unknown[],
  ): Promise<unknown>
  releaseDrawing(owner: ModUiOwner, drawing: number): Promise<void>
  validateTree?: (tree: unknown) => void
}): ModUi {
  const candidates = new Map<ModUiOwner, Map<string, PaneState>>()
  const active = new Map<string, PaneState>()
  const activeOwners = new Set<ModUiOwner>()
  const listeners = new Set<() => void>()
  const personRequested = new Set<string>()
  const openGenerations = new Map<string, number>()
  const pendingDraws = new WeakMap<PaneState, Promise<void>>()
  const pendingBlits = new Map<string, BlitFrame>()
  const serializedBlits = new Map<string, Promise<void>>()
  const blitGenerations = new Map<string, number>()
  const focusWaiters = new Set<() => void>()
  let snapshot: readonly ModUiPane[] = Object.freeze([])
  let nextDrawing = 1
  let revision = 0
  let personFocusGeneration = 0

  function queueBlit(key: string, apply: () => unknown | Promise<unknown>): Promise<unknown> {
    const waiter = Promise.withResolvers<unknown>()
    const pending = pendingBlits.get(key)
    if (pending) {
      pending.apply = apply
      pending.waiters.push(waiter)
      return waiter.promise
    }
    const frame: BlitFrame = { apply, waiters: [waiter] }
    pendingBlits.set(key, frame)
    queueMicrotask(() => {
      if (pendingBlits.get(key) !== frame) return
      pendingBlits.delete(key)
      void Promise.resolve().then(frame.apply).then(
        result => frame.waiters.forEach(entry => entry.resolve(result)),
        error => frame.waiters.forEach(entry => entry.reject(error)),
      )
    })
    return waiter.promise
  }

  function serializeBlit(key: string, apply: () => unknown | Promise<unknown>): Promise<unknown> {
    const previous = serializedBlits.get(key) ?? Promise.resolve()
    const work = previous.then(apply)
    const settled = work.then(() => {}, () => {})
    serializedBlits.set(key, settled)
    void settled.finally(() => {
      if (serializedBlits.get(key) === settled) serializedBlits.delete(key)
    })
    return work
  }

  function blitNode(
    value: unknown,
    plugin: string,
    key: string,
    seen = new Set<object>(),
  ): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || seen.has(value)) return undefined
    seen.add(value)
    if (!Array.isArray(value)) {
      const node = value as Record<string, unknown>
      const props = node.props as Record<string, unknown> | undefined
      if (
        (node.type === 'Raster' || node.type === 'Image') &&
        props?.key === key &&
        (node.group as { plugin?: string } | undefined)?.plugin === plugin
      ) return node
    }
    for (const child of Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>)) {
      const found = blitNode(child, plugin, key, seen)
      if (found) return found
    }
    return undefined
  }

  function replaceNode(
    value: unknown,
    target: Record<string, unknown>,
    replacement: Record<string, unknown>,
    seen = new Map<object, unknown>(),
  ): unknown {
    if (!value || typeof value !== 'object') return value
    if (value === target) return replacement
    if (seen.has(value)) return seen.get(value)
    const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {}
    seen.set(value, output)
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
      Object.defineProperty(output, key, { value: replaceNode(child, target, replacement, seen), enumerable: true })
    return Object.freeze(output)
  }

  function askedKey(owner: ModUiOwner, id: string): string {
    return `${pluginOf(owner)}\0${id}`
  }

  function bodyRowsOf(
    pane: Pick<PaneState, 'rows' | 'presentation' | 'placement'>,
    placement: ModUiPlacement = pane.placement,
  ): number {
    const available = Math.max(1, pane.presentation.rows - 4)
    if (placement === 'dock') return available
    return Math.min(available, pane.rows ?? Math.max(1, Math.floor(available / 3)))
  }

  function bodyColumnsOf(pane: PaneState): number {
    return pane.placement === 'dock'
      ? Math.max(1, Math.floor(pane.presentation.columns / 2) - 2)
      : Math.max(1, pane.presentation.columns - 4)
  }

  function visibleOf(pane: PaneState): boolean {
    if (pane.personInitiated) return true
    const threshold = personRequested.has(askedKey(pane.owner, pane.id)) ? 110 : 144
    return pane.presentation.columns >= threshold
  }

  function placementOf(presentation: ModUiPresentation): ModUiPlacement {
    return presentation.isFullscreen && presentation.columns >= 110 ? 'dock' : 'inline'
  }

  function snapshotPane(pane: PaneState): ModUiPane {
    const visible = pane.visible && pane.tree !== undefined
    return Object.freeze({
      id: pane.id,
      title: pane.title,
      plugin: pane.plugin,
      owner: pane.owner,
      visible,
      placement: pane.placement,
      focused: visible && pane.focused,
      closeOnEscape: pane.closeOnEscape,
      holdToasts: pane.holdToasts,
      ...(pane.rows === undefined ? {} : { rows: pane.rows }),
      scrollOffset: pane.scrollOffset,
      bodyRows: pane.bodyRows,
      bodyColumns: bodyColumnsOf(pane),
      revision,
      contentRows: pane.contentRows,
      ...(pane.focusedElement === undefined ? {} : { focusedElement: pane.focusedElement }),
      ...(pane.tree === undefined ? {} : { tree: pane.tree }),
      ...(pane.drawing === undefined ? {} : { drawing: pane.drawing }),
    })
  }

  function wakeFocusWaiters(): void {
    for (const resolve of focusWaiters) resolve()
  }

  function publish(): void {
    revision++
    snapshot = Object.freeze([...active.values()].map(snapshotPane))
    notify(wakeFocusWaiters)
    for (const listener of [...listeners]) notify(listener)
  }

  async function releaseLease(pane: Pick<PaneState, 'owner' | 'drawing'>): Promise<void> {
    if (pane.drawing === undefined) return
    const drawing = pane.drawing
    pane.drawing = undefined
    await releaseDrawing(pane.owner, drawing)
  }

  function renderInput(pane: PaneState): ModInput {
    return Object.freeze({
      surface: 'terminal',
      component: 'Pane',
      requestId: pane.id,
      viewport: Object.freeze({
        columns: pane.presentation.columns,
        rows: pane.presentation.rows,
      }),
      props: Object.freeze({
        title: pane.title,
        isFocused: pane.focused,
        bodyColumns: bodyColumnsOf(pane),
        placement: pane.placement,
        scroll: Object.freeze({ offset: pane.scrollOffset, bodyRows: pane.bodyRows }),
        view: Object.freeze(
          pane.presentation.agentId === undefined
            ? {}
            : { agentId: pane.presentation.agentId },
        ),
      }),
    })
  }

  async function drawCandidate(pane: PaneState): Promise<void> {
    if (!pane.visible) return
    const drawing = nextDrawing++
    try {
      const tree = await draw(pane.owner, renderInput(pane), drawing)
      if (!tree || typeof tree !== 'object' || Array.isArray(tree))
        throw new TypeError('Mod UI render must return an element object')
      validateTree?.(tree)
      pane.tree = tree
      pane.drawing = drawing
    } catch (error) {
      await releaseDrawing(pane.owner, drawing).catch(() => {})
      throw error
    }
  }

  function redraw(pane: PaneState): Promise<void> {
    const work = drawPane(pane).finally(() => {
      if (pendingDraws.get(pane) === work) pendingDraws.delete(pane)
    })
    pendingDraws.set(pane, work)
    wakeFocusWaiters()
    return work
  }

  async function drawPane(pane: PaneState): Promise<void> {
    const generation = ++pane.drawGeneration
    if (!pane.visible) {
      const hadDrawing = pane.drawing !== undefined
      await releaseLease(pane).catch(() => {})
      pane.tree = undefined
      if (hadDrawing && active.get(pane.id) === pane) publish()
      return
    }
    const drawing = nextDrawing++
    let tree: unknown
    try {
      tree = await draw(pane.owner, renderInput(pane), drawing)
      if (!tree || typeof tree !== 'object' || Array.isArray(tree))
        throw new TypeError('Mod UI render must return an element object')
      validateTree?.(tree)
    } catch (error) {
      await releaseDrawing(pane.owner, drawing).catch(() => {})
      throw error
    }
    if (
      active.get(pane.id) !== pane ||
      pane.drawGeneration !== generation ||
      !pane.visible
    ) {
      await releaseDrawing(pane.owner, drawing).catch(() => {})
      return
    }
    const oldDrawing = pane.drawing
    pane.drawing = drawing
    pane.tree = tree
    publish()
    if (oldDrawing !== undefined)
      await releaseDrawing(pane.owner, oldDrawing).catch(() => {})
  }

  function openState(
    owner: ModUiOwner,
    existing: PaneState | undefined,
    spec: Readonly<ModUiOpenArgs>,
    origin: Exclude<ModUiOrigin, { kind: 'unload' }>,
    presentation: ModUiPresentation,
  ): PaneState {
    const pane: PaneState = existing
      ? {
          ...existing,
          presentation: existing.presentation,
          keyRows: existing.keyRows,
          tree: undefined,
          drawing: undefined,
        }
      : {
          id: spec.id,
          title: spec.id,
          plugin: pluginOf(owner),
          owner,
          visible: false,
          placement: placementOf(presentation),
          focused: false,
          closeOnEscape: false,
          holdToasts: false,
          scrollOffset: 0,
          bodyRows: 1,
          contentRows: 0,
          presentation,
          personInitiated: false,
          drawGeneration: 0,
          keyRows: Object.freeze([]),
        }
    pane.measuredBodyRows = undefined
    pane.title = spec.title ?? spec.id
    pane.closeOnEscape = spec.closeOnEscape === true
    pane.holdToasts = spec.holdToasts === true
    pane.rows = spec.rows
    pane.personInitiated = origin.kind === 'person' || (existing?.owner === owner && existing.personInitiated)
    if (
      spec.focus === true &&
      presentation.composerEmpty &&
      !presentation.hasDialog &&
      !presentation.keyboardOwned
    ) {
      pane.focused = true
    }
    updatePresentation(pane, presentation)
    return pane
  }

  function updatePresentation(pane: PaneState, presentation: ModUiPresentation): boolean {
    const placement = placementOf(presentation)
    if (pane.presentation.columns !== presentation.columns ||
        pane.presentation.rows !== presentation.rows || pane.placement !== placement) {
      pane.measuredBodyRows = undefined
    }
    pane.presentation = presentation
    const visible = visibleOf(pane)
    const focused = pane.focused && presentation.composerEmpty &&
      !presentation.hasDialog && !presentation.keyboardOwned
    const bodyRows = pane.measuredBodyRows ?? bodyRowsOf(pane, placement)
    const scrollOffset = Math.min(
      pane.scrollOffset,
      Math.max(0, pane.contentRows - bodyRows),
    )
    const changed = pane.placement !== placement || pane.visible !== visible ||
      pane.focused !== focused || pane.bodyRows !== bodyRows ||
      pane.scrollOffset !== scrollOffset
    pane.placement = placement
    pane.visible = visible
    pane.focused = focused
    pane.bodyRows = bodyRows
    pane.scrollOffset = scrollOffset
    return changed
  }

  function ownsPane(owner: ModUiOwner, pane: PaneState): boolean {
    return pane.owner === owner || pluginOf(pane.owner) === pluginOf(owner)
  }

  function focusableNode(
    value: unknown,
    element: string,
    plugin: string,
    seen = new Set<object>(),
  ): boolean {
    if (!value || typeof value !== 'object' || seen.has(value)) return false
    seen.add(value)
    if (!Array.isArray(value)) {
      const node = value as Record<string, unknown>
      const props = node.props as Record<string, unknown> | undefined
      const press = node.press as Partial<ModUiCallback> | undefined
      if (
        ['Button', 'Select', 'Input'].includes(String(node.type)) &&
        props?.key === element &&
        press?.plugin === plugin
      ) return true
    }
    for (const child of Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>)) {
      if (focusableNode(child, element, plugin, seen)) return true
    }
    return false
  }

  function interactiveNode(
    value: unknown,
    kind: ModUiInteraction,
    element: string,
    callback: ModUiCallback,
    seen = new Set<object>(),
  ): boolean {
    if (!value || typeof value !== 'object' || seen.has(value)) return false
    seen.add(value)
    if (!Array.isArray(value)) {
      const node = value as Record<string, unknown>
      const expectedType = kind === 'press'
        ? 'Button'
        : kind === 'select'
          ? 'Select'
          : 'Input'
      const props = node.props as Record<string, unknown> | undefined
      const press = node.press as Partial<ModUiCallback> | undefined
      if (
        node.type === expectedType &&
        props?.key === element &&
        press?.plugin === callback.plugin &&
        press.handle === callback.handle
      ) return true
    }
    for (const child of Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>)) {
      if (interactiveNode(child, kind, element, callback, seen)) return true
    }
    return false
  }

  const ui: ModUi = {
    async open(owner, input, origin, rawPresentation) {
      validateOwner(owner)
      const requested = copyOpen(input)
      const presentation = validatePresentation(rawPresentation)
      return dispatch(
        owner,
        'ui.open',
        requested as ModInput,
        async rewritten => {
          const spec = copyOpen(rewritten as ModUiOpenArgs, requested.id)
          if (origin.kind === 'person')
            personRequested.add(askedKey(owner, spec.id))
          const committed = activeOwners.has(owner)
          const store = committed
            ? active
            : (candidates.get(owner) ?? new Map<string, PaneState>())
          if (!committed && !candidates.has(owner)) candidates.set(owner, store)
          const existing = store.get(spec.id)
          if (committed && existing && !ownsPane(owner, existing))
            throw new Error(`Mod UI pane ${spec.id} is already owned by another activation`)
          if (!committed) {
            store.set(spec.id, openState(owner, existing, spec, origin, presentation))
            return undefined
          }

          if (!existing) {
            const pane = openState(owner, undefined, spec, origin, presentation)
            active.set(spec.id, pane)
            if (!pane.visible) {
              publish()
              return undefined
            }
            try {
              await redraw(pane)
            } catch (error) {
              publish()
              throw error
            }
            return undefined
          }

          const key = askedKey(owner, spec.id)
          const generation = (openGenerations.get(key) ?? 0) + 1
          openGenerations.set(key, generation)
          const pane = openState(owner, existing, spec, origin, presentation)
          try {
            await drawCandidate(pane)
          } catch (error) {
            if (openGenerations.get(key) === generation)
              openGenerations.delete(key)
            throw error
          }
          if (openGenerations.get(key) !== generation) {
            await releaseLease(pane).catch(() => {})
            return undefined
          }
          openGenerations.delete(key)
          if (existing && active.get(spec.id) !== existing) {
            await releaseLease(pane).catch(() => {})
            return undefined
          }
          if (spec.focus === true) {
            for (const current of active.values()) current.focused = false
          }
          active.set(spec.id, pane)
          publish()
          if (existing) {
            existing.drawGeneration++
            await releaseLease(existing).catch(() => {})
          }
          return undefined
        },
        { origin },
      )
    },

    async close(owner, id, origin) {
      validateOwner(owner)
      if (typeof id !== 'string' || !idPattern.test(id))
        throw new TypeError('Mod UI pane id is invalid')
      const committed = activeOwners.has(owner)
      const store = committed ? active : candidates.get(owner)
      const pane = store?.get(id)
      if (!pane) return undefined
      if (origin.kind === 'plugin' && !ownsPane(owner, pane))
        return { deny: 'the pane belongs to another plugin' }
      if (origin.kind === 'unload') {
        store!.delete(id)
        pane.drawGeneration++
        if (committed) publish()
        await releaseLease(pane).catch(() => {})
      }
      return dispatch(
        owner,
        'ui.close',
        Object.freeze({ id, origin }) as ModInput,
        async rewritten => {
          if (rewritten.id !== id)
            throw new TypeError('Mod UI hooks cannot rename a closing pane')
          if (origin.kind === 'unload') return undefined
          if (store?.get(id) !== pane) return undefined
          store.delete(id)
          pane.drawGeneration++
          if (committed) publish()
          await releaseLease(pane).catch(() => {})
          return undefined
        },
        { origin, ...(origin.kind === 'unload' ? { skipOwner: pane.owner } : {}) },
      )
    },

    async blit(owner, input) {
      validateOwner(owner)
      if (typeof input.requestId !== 'string' || !idPattern.test(input.requestId) ||
          typeof input.key !== 'string' || !input.key)
        throw new TypeError('Mod UI blit requires a valid requestId and key')
      const pane = active.get(input.requestId)
      const plugin = pluginOf(owner)
      const key = `${input.requestId}\0${plugin}\0${input.key}`
      const generation = (blitGenerations.get(key) ?? 0) + 1
      blitGenerations.set(key, generation)
      if (!pane || !pane.visible || pane.tree === undefined) {
        return { deny: 'site is not open' }
      }
      const target = blitNode(pane.tree, plugin, input.key)
      if (!target) return { deny: 'no owned Raster or Image is mounted under that key' }
      const props = target.props as Record<string, unknown>
      if (input.columns !== undefined && input.columns !== props.columns ||
          input.rows !== undefined && input.rows !== props.rows)
        return { deny: 'mounted dimensions do not match' }
      const raster = target.type === 'Raster'
      if (raster !== (input.cells !== undefined) || raster === (input.source !== undefined))
        return { deny: 'blit payload kind does not match the mounted element' }
      const received = Object.freeze({ ...input }) as ModInput
      return dispatch(owner, 'ui.blit', received, async rewritten => {
        if (rewritten.requestId !== input.requestId || rewritten.key !== input.key)
          throw new TypeError('Mod UI blit cannot rewrite requestId or key')
        if (raster !== (typeof rewritten.cells === 'string') || raster === (rewritten.source !== undefined))
          throw new TypeError('Mod UI blit cannot change the mounted element kind')
        if (rewritten.columns !== undefined && rewritten.columns !== props.columns ||
            rewritten.rows !== undefined && rewritten.rows !== props.rows)
          return { deny: 'mounted dimensions do not match' }
        const source = rewritten.source
        const shared = !raster && source !== null && typeof source === 'object' &&
          Object.hasOwn(source, 'shm')
        const apply = () => {
          if (!shared && blitGenerations.get(key) !== generation) return {}
          if (active.get(pane.id) !== pane || pane.tree === undefined || !pane.visible)
            return { deny: 'site is no longer mounted' }
          const latest = blitNode(pane.tree, plugin, input.key)
          if (!latest) return { deny: 'no owned Raster or Image is mounted under that key' }
          const latestProps = latest.props as Record<string, unknown>
          if (latest.type !== target.type)
            return { deny: 'blit payload kind does not match the mounted element' }
          if (rewritten.columns !== undefined && rewritten.columns !== latestProps.columns ||
              rewritten.rows !== undefined && rewritten.rows !== latestProps.rows)
            return { deny: 'mounted dimensions do not match' }
          const replacement = Object.freeze({
            ...latest,
            props: Object.freeze({
              ...latestProps,
              ...(raster ? { cells: rewritten.cells } : { source: rewritten.source }),
            }),
          })
          const tree = replaceNode(pane.tree, latest, replacement)
          validateTree?.(tree)
          pane.tree = tree
          publish()
          return {}
        }
        return shared
          ? serializeBlit(key, async () => {
              const result = apply()
              if ((result as { deny?: string }).deny === undefined)
                await new Promise<void>(resolve => setImmediate(resolve))
              return result
            })
          : queueBlit(key, apply)
      }, {
        origin: { kind: 'plugin', name: plugin },
        restoreInput: (rewritten, original) => ({ ...original, ...rewritten }),
      })
    },

    async invalidate(owner, event) {
      validateOwner(owner)
      if (event !== invalidatableRenderEvent || !activeOwners.has(owner)) return
      const panes = [...active.values()].filter(pane => ownsPane(owner, pane))
      await Promise.all(panes.map(redraw))
    },

    async render(rawPresentation) {
      const presentation = validatePresentation(rawPresentation)
      const work: Promise<void>[] = []
      let changed = false
      for (const pane of active.values()) {
        changed = updatePresentation(pane, presentation) || changed
        work.push(redraw(pane))
      }
      if (changed) publish()
      await Promise.all(work)
    },

    async scroll(owner, request) {
      validateOwner(owner)
      const pane = active.get(request.requestId)
      if (!pane) return { deny: 'site is not open' }
      if (!Number.isFinite(request.by))
        throw new TypeError('Mod UI scroll distance must be finite')
      if (request.origin.kind === 'plugin' && !ownsPane(owner, pane))
        return { deny: 'site belongs to another plugin' }
      const max = Math.max(0, pane.contentRows - pane.bodyRows)
      const offset = Math.max(0, Math.min(max, pane.scrollOffset + request.by))
      const input: ModInput = Object.freeze({
        component: 'Pane',
        requestId: pane.id,
        offset,
        by: request.by,
        bodyRows: pane.bodyRows,
        contentRows: pane.contentRows,
        origin: request.origin,
        ...(request.pointer === undefined ? {} : { pointer: request.pointer }),
      })
      return dispatch(owner, 'ui.scroll', input, async rewritten => {
        if (active.get(pane.id) !== pane) return { deny: 'the window moved meanwhile' }
        for (const key of [
          'component', 'requestId', 'by', 'bodyRows', 'contentRows', 'pointer',
        ] as const) {
          const unchanged = key === 'pointer'
            ? isDeepStrictEqual(rewritten[key], input[key])
            : rewritten[key] === input[key]
          if (Object.hasOwn(rewritten, key) && !unchanged)
            throw new TypeError(`Mod UI scroll cannot rewrite ${key}`)
        }
        const receivedOrigin = rewritten.origin as ModUiOrigin | undefined
        if (!receivedOrigin || receivedOrigin.kind !== request.origin.kind ||
            receivedOrigin.kind === 'plugin' &&
            receivedOrigin.name !== (request.origin as Extract<ModUiOrigin, { kind: 'plugin' }>).name)
          throw new TypeError('Mod UI scroll cannot rewrite origin')
        if (!Number.isInteger(rewritten.offset) || (rewritten.offset as number) < 0)
          throw new TypeError('Mod UI scroll offset must be a non-negative whole row')
        pane.scrollOffset = Math.min(max, rewritten.offset as number)
        publish()
        return {}
      }, {
        origin: request.origin,
        restoreInput: (rewritten, received) => {
          const restored = { ...rewritten }
          for (const key of [
            'component', 'requestId', 'by', 'bodyRows', 'contentRows', 'origin',
            'pointer',
          ]) {
            if (!Object.hasOwn(restored, key) && Object.hasOwn(received, key))
              restored[key] = received[key]
          }
          return restored
        },
      })
    },

    async focus(owner, request, rawPresentation) {
      validateOwner(owner)
      const person = request.origin.kind === 'person'
      const pane = active.get(request.requestId)
      if (!pane) return { deny: 'site is not open', ...(person ? { focused: false } : {}) }
      if (request.origin.kind === 'plugin' && !ownsPane(owner, pane))
        return { deny: 'site belongs to another plugin' }
      if (person && rawPresentation !== undefined) {
        pane.presentation = validatePresentation(rawPresentation)
        if (pane.focused && (!visibleOf(pane) || !pane.presentation.composerEmpty ||
            pane.presentation.hasDialog || pane.presentation.keyboardOwned)) {
          pane.focused = false
          pane.focusedElement = undefined
          publish()
        }
      }
      const generation = person ? ++personFocusGeneration : personFocusGeneration
      if (person) wakeFocusWaiters()
      const input: ModInput = Object.freeze({
        component: 'Pane',
        requestId: pane.id,
        ...(request.element === undefined ? {} : { plugin: pane.plugin, element: request.element }),
        origin: request.origin,
      })
      const result = await dispatch(owner, 'ui.focus', input, async rewritten => {
        if (active.get(pane.id) !== pane || person && generation !== personFocusGeneration)
          return { deny: 'another move landed first' }
        if (!pane.visible || !visibleOf(pane) || pane.tree === undefined)
          return { deny: 'site is not visible' }
        const presentation = pane.presentation
        const canFocus = person && request.element !== undefined
          ? presentation.composerEmpty && !presentation.hasDialog && !presentation.keyboardOwned
          : pane.focused
        if (!canFocus) return { deny: 'site does not hold the keyboard' }
        for (const key of ['component', 'requestId', 'plugin'] as const) {
          if (Object.hasOwn(rewritten, key) && rewritten[key] !== input[key])
            throw new TypeError(`Mod UI focus cannot rewrite ${key}`)
        }
        const receivedOrigin = rewritten.origin as ModUiOrigin | undefined
        if (!receivedOrigin || receivedOrigin.kind !== request.origin.kind ||
            receivedOrigin.kind === 'plugin' &&
            receivedOrigin.name !== (request.origin as Extract<ModUiOrigin, { kind: 'plugin' }>).name)
          throw new TypeError('Mod UI focus cannot rewrite origin')
        const nextElement = rewritten.element
        if (input.element === undefined && nextElement !== undefined ||
            input.element !== undefined && (typeof nextElement !== 'string' || nextElement.length === 0))
          throw new TypeError('Mod UI focus cannot add or remove an element')
        if (nextElement !== undefined &&
            !focusableNode(pane.tree, nextElement as string, input.plugin as string))
          return { deny: 'element is not drawn in this site' }
        const relinquish = nextElement === undefined && person
        let changed = false
        if (person && !relinquish) {
          for (const current of active.values()) {
            if (current === pane || !current.focused) continue
            current.focused = false
            current.focusedElement = undefined
            changed = true
          }
        }
        const focused = !relinquish
        if (pane.focusedElement !== nextElement || pane.focused !== focused) {
          pane.focusedElement = nextElement as string | undefined
          pane.focused = focused
          changed = true
        }
        if (changed) publish()
        return {}
      }, {
        origin: request.origin,
        restoreInput: (rewritten, received) => {
          const restored = { ...rewritten }
          for (const key of [
            'component', 'requestId', 'plugin', 'origin', 'element',
          ]) {
            if (!Object.hasOwn(restored, key) && Object.hasOwn(received, key))
              restored[key] = received[key]
          }
          return restored
        },
      })
      if (!person) return result
      // Fire-and-forget invalidation may still be publishing this move's tree.
      while (request.element !== undefined && active.get(pane.id) === pane &&
          pane.visible && pane.focused && generation === personFocusGeneration) {
        const drawing = pendingDraws.get(pane)
        if (!drawing) break
        const drawGeneration = pane.drawGeneration
        const changed = Promise.withResolvers<void>()
        focusWaiters.add(changed.resolve)
        try {
          await Promise.race([drawing, changed.promise])
        } catch (error) {
          if (active.get(pane.id) === pane && pane.visible && pane.focused &&
              generation === personFocusGeneration && drawGeneration === pane.drawGeneration)
            throw error
        } finally {
          focusWaiters.delete(changed.resolve)
        }
      }
      const landing = active.get(request.requestId)
      const focused = Boolean(landing?.visible && landing.tree !== undefined && landing.focused)
      // Middleware can withhold core, redirect it or move focus again after next().
      const reported: Record<string, unknown> = { ...(result as Record<string, unknown>), focused }
      delete reported.element
      if (focused && landing?.focusedElement !== undefined)
        reported.element = landing.focusedElement
      return reported
    },

    async reveal(owner, request) {
      validateOwner(owner)
      if (request.targetRequestId !== undefined) {
        const targetIsSite = [...active.values()].some(pane =>
          ownsPane(owner, pane) && pane.id === request.targetRequestId)
        return targetIsSite
          ? { deny: 'nothing around that site scrolls' }
          : { deny: 'transcript not scrollable here' }
      }
      const panes = request.requestId === undefined
        ? [...active.values()].filter(pane => ownsPane(owner, pane))
        : [active.get(request.requestId)].filter((pane): pane is PaneState => pane !== undefined)
      if (request.requestId !== undefined &&
          (panes.length === 0 || !ownsPane(owner, panes[0]!)))
        return { deny: 'not this plugin\'s site' }
      const pane = request.key === undefined
        ? panes[0]
        : panes.find(item => item.keyRows.some(row =>
          row.plugin === pluginOf(owner) && row.key === request.key))
      if (!pane) return request.key === undefined
        ? { deny: 'not this plugin\'s site' }
        : { deny: 'no element of its own is drawn under that key' }
      let offset: number
      if (request.edge !== undefined) {
        offset = request.edge === 'start'
          ? 0
          : Math.max(0, pane.contentRows - pane.bodyRows)
      } else {
        const row = pane.keyRows.find(item =>
          item.plugin === pluginOf(owner) && item.key === request.key)!
        const height = row.bottom - row.top
        const block = request.block ?? 'nearest'
        if (height > pane.bodyRows || block === 'start') offset = row.top
        else if (block === 'end') offset = row.bottom - pane.bodyRows
        else if (block === 'center')
          offset = row.top - Math.floor((pane.bodyRows - height) / 2)
        else if (row.top < pane.scrollOffset) offset = row.top
        else if (row.bottom > pane.scrollOffset + pane.bodyRows)
          offset = Math.max(row.top, row.bottom - pane.bodyRows)
        else offset = pane.scrollOffset
      }
      const max = Math.max(0, pane.contentRows - pane.bodyRows)
      const target = Math.max(0, Math.min(max, offset))
      return ui.scroll(owner, {
        requestId: pane.id,
        by: target - pane.scrollOffset,
        origin: request.origin,
      })
    },

    async interact(id, drawing, callback, kind, element, value) {
      validateCallback(callback)
      if (!idPattern.test(id) || !Number.isInteger(drawing) || drawing < 1)
        throw new TypeError('Mod UI interaction address is invalid')
      if (!['press', 'input.change', 'input.submit', 'select'].includes(kind))
        throw new TypeError('Mod UI interaction kind is invalid')
      if (typeof element !== 'string' || !element)
        throw new TypeError('Mod UI interaction element is invalid')
      if (kind !== 'press' && typeof value !== 'string')
        throw new TypeError('Mod UI interaction value must be a string')
      const pane = active.get(id)
      if (
        !pane ||
        pane.drawing !== drawing ||
        !pane.visible ||
        !interactiveNode(pane.tree, kind, element, callback)
      ) throw new Error('Mod UI drawing callback is stale')
      const event = kind === 'press'
        ? 'ui.press'
        : kind === 'select'
          ? 'ui.select'
          : 'ui.input'
      const input: ModInput = Object.freeze({
        plugin: callback.plugin,
        element,
        component: 'Pane',
        requestId: id,
        surface: 'terminal',
        ...(kind === 'press'
          ? {}
          : kind === 'select'
            ? { value }
            : { kind: kind === 'input.submit' ? 'submit' : 'change', value }),
      })
      return dispatch(pane.owner, event, input, async rewritten => {
        if (active.get(id) !== pane || pane.drawing !== drawing)
          throw new Error('Mod UI drawing callback is stale')
        await invokeDrawing(pane.owner, drawing, callback.handle, [rewritten])
        return kind === 'press'
          ? { element: rewritten.element }
          : { element: rewritten.element, value: rewritten.value }
      }, { origin: { kind: 'person' } })
    },

    reportMetrics(id, metrics) {
      const pane = active.get(id)
      if (!pane) return
      if (
        !Number.isInteger(metrics.bodyRows) || metrics.bodyRows < 1 ||
        !Number.isInteger(metrics.contentRows) || metrics.contentRows < 0
      ) throw new TypeError('Mod UI pane metrics must be non-negative whole rows')
      const keyRows = Object.freeze((metrics.keyRows ?? []).map(row => {
        if (!row || typeof row !== 'object' ||
            typeof row.plugin !== 'string' || !row.plugin ||
            typeof row.key !== 'string' || !row.key ||
            !Number.isInteger(row.top) || row.top < 0 ||
            !Number.isInteger(row.bottom) || row.bottom < row.top)
          throw new TypeError('Mod UI key rows must carry plugin, key, top, and bottom')
        return Object.freeze({ ...row })
      }))
      const scrollOffset = Math.min(
        pane.scrollOffset,
        Math.max(0, metrics.contentRows - metrics.bodyRows),
      )
      const sameKeyRows = pane.keyRows.length === keyRows.length &&
        pane.keyRows.every((row, index) => {
          const next = keyRows[index]!
          return row.plugin === next.plugin && row.key === next.key &&
            row.top === next.top && row.bottom === next.bottom
        })
      const bodyChanged = pane.bodyRows !== metrics.bodyRows
      pane.measuredBodyRows = metrics.bodyRows
      if (
        !bodyChanged &&
        pane.contentRows === metrics.contentRows &&
        pane.scrollOffset === scrollOffset &&
        sameKeyRows
      ) return
      pane.bodyRows = metrics.bodyRows
      pane.contentRows = metrics.contentRows
      pane.scrollOffset = scrollOffset
      pane.keyRows = keyRows
      publish()
      if (bodyChanged) return redraw(pane)
    },

    async commit(owner, replacedOwner) {
      const publish = await this.prepareCommit(owner, replacedOwner)
      await publish()
    },

    async prepareCommit(owner, replacedOwner, preparedOwners = []) {
      validateOwner(owner)
      if (replacedOwner !== undefined) validateOwner(replacedOwner)
      const next = candidates.get(owner) ?? new Map<string, PaneState>()
      for (const [id] of next) {
        const current = active.get(id)
        if ((current && current.owner !== owner && current.owner !== replacedOwner) ||
            preparedOwners.some(other => other !== owner && candidates.get(other)?.has(id)))
          throw new Error(`Mod UI pane ${id} is already owned by another activation`)
      }
      const prepared: PaneState[] = []
      try {
        for (const pane of next.values()) {
          await drawCandidate(pane)
          prepared.push(pane)
        }
      } catch (error) {
        await Promise.all(prepared.map(pane => releaseLease(pane).catch(() => {})))
        throw error
      }
      return () => {
        const removed: PaneState[] = []
        for (const [id, pane] of [...active]) {
          if (pane.owner === owner || pane.owner === replacedOwner) {
            active.delete(id)
            pane.drawGeneration++
            removed.push(pane)
          }
        }
        for (const pane of prepared) active.set(pane.id, pane)
        candidates.delete(owner)
        activeOwners.add(owner)
        if (replacedOwner !== undefined) activeOwners.delete(replacedOwner)
        if (removed.length > 0 || prepared.length > 0) publish()
        return Promise.all(removed.map(pane => releaseLease(pane).catch(() => {}))).then(() => {})
      }
    },

    releaseCandidate(owner) {
      validateOwner(owner)
      candidates.delete(owner)
    },

    async release(owner) {
      validateOwner(owner)
      candidates.delete(owner)
      activeOwners.delete(owner)
      const removed: PaneState[] = []
      for (const [id, pane] of [...active]) {
        if (pane.owner !== owner) continue
        active.delete(id)
        pane.drawGeneration++
        removed.push(pane)
      }
      if (removed.length > 0) publish()
      await Promise.all(removed.map(async pane => {
        await releaseLease(pane).catch(() => {})
        await dispatch(
          owner,
          'ui.close',
          Object.freeze({ id: pane.id, origin: { kind: 'unload' } }) as ModInput,
          async () => undefined,
          { origin: { kind: 'unload' }, skipOwner: owner },
        ).catch(() => {})
      }))
    },

    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  return ui
}
