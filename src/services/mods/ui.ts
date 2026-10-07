import { isDeepStrictEqual } from 'node:util'
import { logForDebugging } from '../../utils/debug.js'
import type { ModInput } from './types.js'
import type { ModClients, ModClientHandle, ModClientSite } from './client.js'

export type ModRenderSurface = 'terminal' | 'desktop' | 'mobile' | 'vscode'
export type ModRenderComponent = 'AskUserQuestion' | 'UserMessage' | 'AssistantMessage' | 'ToolUse' | 'ToolResult' | 'ToolGroup' | 'ToolProgress' | 'CommandOutput' | 'Spinner' | 'TurnDuration' | 'InfoNotice' | 'SessionMode' | 'PromptHint' | 'AbovePrompt' | 'Pane'
export type ModRenderInput = {
  surface: ModRenderSurface
  component: ModRenderComponent
  requestId: string
  props: ModInput
  viewport?: { columns: number; rows: number; isFullscreen?: boolean }
}
export type ModClientBinding = { handle: ModClientHandle; tree?: unknown }
export type ModUiFocusTarget = Readonly<{ plugin: string; element: string }>
export type ModRenderFocusController = {
  isHeldNow(): boolean
  holderNow(): ModUiFocusTarget | undefined
  hasElement(plugin: string, element: string): boolean
  commit(target: ModUiFocusTarget): string | void
}
export type ModRenderConsumer = {
  surface: ModRenderSurface
  clientId?: string
  clientClock?: 'manual'
  signal?: AbortSignal
  /** Host binding is available before the first asynchronous drawing settles. */
  onMount?(site: ModRenderSite): void
  retainClients?: boolean
  /** SDK clients execute their module bundle externally and own their transport attachment. */
  externalClients?: true
  focus?: ModRenderFocusController
  render(tree: unknown, drawing: number, resolveEngine: (ref: number) => ModInput, clients?: ReadonlyMap<string, ModClientBinding>): void | Promise<void>
  unmount(): void | Promise<void>
}
export type ModRenderSite = {
  focus(input: { plugin: string; element: string; origin: Exclude<ModUiOrigin, { kind: 'unload' }> }, options?: ModUiHostFocusOptions): Promise<unknown>
  key(event: { key: string; ctrl?: true; shift?: true; meta?: true; in?: string }): Promise<void>
  pointer(event: { type: 'down' | 'move' | 'up' | 'enter' | 'leave'; x: number; y: number; fine?: { x: number; y: number }; button?: 'left' | 'middle' | 'right'; shift?: true; alt?: true; ctrl?: true; in?: string }): Promise<void>
  resize(size: { columns: number; rows: number; in?: string }): Promise<void>
  post(data: unknown, scope?: { in?: string }): Promise<void>
  advance(ms: number): Promise<void>
  getTree(scope?: { in?: string }): unknown
  update(input: ModRenderInput): Promise<void>
  interact(drawing: number, callback: ModUiCallback, kind: ModUiInteraction, element: string, value?: string, scope?: { in?: string }): Promise<unknown>
  dispose(): Promise<void>
}

export type ModUiOwner = object

/** Private host-controller state; never decoded from an author call. */
export type ModUiHostFocusOptions = {
  signal?: AbortSignal
  expectedElement?: string
}
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
  columns?: number
}

export type ModUiCallback = { plugin: string; handle: number; client?: string }
export type ModUiInteraction =
  | 'press'
  | 'link.press'
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
  clients?: ModClients
  clientBindings?: ReadonlyMap<string, ModClientBinding>
  id: string
  title: string
  plugin: string
  owner: ModUiOwner
  visible: boolean
  shown?: boolean
  placement: ModUiPlacement
  focused: boolean
  closeOnEscape: boolean
  holdToasts: boolean
  rows?: number
  columns?: number
  scrollOffset: number
  bodyRows: number
  bodyColumns: number
  /** Inline viewport cap, independent of the last measured content height. */
  bodyRowLimit?: number
  revision: number
  contentRows: number
  focusedElement?: string
  focusedPlugin?: string
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
    drawing?: number
    skipOwner?: ModUiOwner
    automaticFocus?: true
    signal?: AbortSignal
    restoreInput?: (rewritten: ModInput, received: ModInput) => ModInput
  },
) => Promise<unknown>

export type ModUi = {
  mount(input: ModRenderInput, consumer: ModRenderConsumer): Promise<ModRenderSite>
  dispose(): Promise<void>
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
  invalidateInstance(instance: Pick<ModRenderInput, 'surface' | 'component' | 'requestId'>): Promise<void>
  render(presentation?: ModUiPresentation, options?: { nativeSites?: boolean }): Promise<void>
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
  focusHost(
    owner: ModUiOwner,
    input: { requestId: string; element: string; origin: { kind: 'plugin'; name: string } },
    presentation?: ModUiPresentation,
    options?: ModUiHostFocusOptions,
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
  getClientSite(owner: ModUiOwner, id: string): ModClientSite | undefined
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

type RedrawWaiter = {
  promise: Promise<void>
  resolve(): void
  reject(reason?: unknown): void
}

type RedrawSchedule = {
  lastStarted: number
  running: number
  scheduled: boolean
  resume?: () => void
  timer?: ReturnType<typeof setTimeout>
  waiters: RedrawWaiter[]
}

type BlitFrame = {
  apply(): unknown | Promise<unknown>
  waiters: ReturnType<typeof Promise.withResolvers<unknown>>[]
}

const idPattern = /^[A-Za-z0-9_-]{1,64}$/
const invalidatableRenderEvent = 'ui.render'
const normalRedrawInterval = 100
const shownRedrawInterval = 1000 / 30

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
  if (input.columns !== undefined && (!Number.isInteger(input.columns) || input.columns < 1))
    throw new TypeError('Mod UI pane columns must be a positive integer')
  return Object.freeze({
    id: input.id,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.focus === true ? { focus: true as const } : {}),
    ...(input.closeOnEscape === true ? { closeOnEscape: true as const } : {}),
    ...(input.holdToasts === true ? { holdToasts: true as const } : {}),
    ...(input.rows === undefined ? {} : { rows: input.rows }),
    ...(input.columns === undefined ? {} : { columns: input.columns }),
  })
}

function freezeRenderTree(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) freezeRenderTree(child, seen)
  return Object.freeze(value)
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
  asked = [],
  onAskedChange,
  notify = listener => listener(),
  pluginOf,
  dispatch,
  draw,
  invokeDrawing,
  releaseDrawing,
  validateTree,
  attach,
  detach,
  clients,
}: {
  asked?: readonly { plugin: string; id: string }[]
  onAskedChange?(plugin: string, id: string, asked: boolean): void
  notify?: (listener: () => void) => void
  pluginOf(owner: ModUiOwner): string
  dispatch: ModUiDispatch
  draw(owner: ModUiOwner, input: ModRenderInput, drawing: number, core?: (input: ModInput) => Promise<unknown>, validate?: (tree: unknown) => void, signal?: AbortSignal): Promise<unknown>
  invokeDrawing(
    owner: ModUiOwner,
    drawing: number,
    handle: number,
    args: unknown[],
  ): Promise<unknown>
  releaseDrawing(owner: ModUiOwner, drawing: number): Promise<void>
  validateTree?: (tree: unknown, input?: ModRenderInput, engineRefs?: ReadonlySet<number>) => void
  attach?(input: { surface: ModRenderSurface; clientId: string; viewport?: ModRenderInput['viewport'] }, signal?: AbortSignal): Promise<void>
  detach?(input: { surface: ModRenderSurface; clientId: string; reason: 'detach' }, signal?: AbortSignal): Promise<void>
  clients?: ModClients
}): ModUi {
  const candidates = new Map<ModUiOwner, Map<string, PaneState>>()
  const active = new Map<string, PaneState>()
  const activeOwners = new Set<ModUiOwner>()
  const listeners = new Set<() => void>()
  const personRequested = new Set(asked.map(pane => `${pane.plugin}\0${pane.id}`))
  const openGenerations = new Map<string, number>()
  const pendingDraws = new WeakMap<PaneState, Promise<void>>()
  const paneRedraws = new WeakMap<PaneState, RedrawSchedule>()
  const siteRedraws = new WeakMap<ModRenderSite, RedrawSchedule>()
  const pendingBlits = new Map<string, BlitFrame>()
  const serializedBlits = new Map<string, Promise<void>>()
  const blitGenerations = new Map<string, number>()
  const focusWaiters = new Set<() => void>()
  const clientSites = new Map<ModUiOwner, ModClientSite>()
  const reconcileClients = () => clients?.reconcile([...snapshot, ...clientSites.values()])
  const siteInputs = new WeakMap<ModRenderSite, ModRenderInput>()
  const sites = new Map<ModUiOwner, ModRenderSite & {
    focusPlugin(owner: ModUiOwner, element: string, origin: Extract<ModUiOrigin, { kind: 'plugin' }>): Promise<unknown>
    redraw(): Promise<void>
    cancelPending(): void
    blit(plugin: string, input: {
      requestId: string; key: string; cells?: string; source?: unknown
      columns?: number; rows?: number
    }): Promise<unknown>
  }>()
  let snapshot: readonly ModUiPane[] = Object.freeze([])
  let nextDrawing = 1
  let revision = 0
  let personFocusGeneration = 0
  const automaticFocusRequests = new WeakMap<object, ModUiHostFocusOptions>()

  function askedKey(owner: ModUiOwner, id: string): string {
    return `${pluginOf(owner)}\0${id}`
  }

  function bodyRowsOf(
    pane: Pick<PaneState, 'rows' | 'presentation' | 'placement'>,
    placement: ModUiPlacement = pane.placement,
  ): number {
    if (placement === 'dock') return Math.max(0, pane.presentation.rows - 1)
    const tabs = [...active.values()].filter(other => other.visible && other.placement === 'inline').length > 1
    const chrome = (tabs ? 1 : 0) + 2
    const defaultBudget = Math.floor(pane.presentation.rows / 3)
    const maxBudget = pane.presentation.isFullscreen ? defaultBudget
      : Math.max(defaultBudget, pane.presentation.rows - 3 - 8)
    const outerBudget = pane.rows === undefined ? defaultBudget
      : Math.min(maxBudget, Math.max(Math.min(5, maxBudget), pane.rows + chrome))
    return Math.max(0, outerBudget - chrome)
  }

  function bodyColumnsOf(pane: PaneState): number {
    const columns = pane.presentation.columns
    if (pane.placement !== 'dock') return Math.max(1, columns - 4)
    const dockColumns = pane.columns === undefined
      ? Math.min(Math.floor(columns * 0.45), 90, columns - 70)
      : Math.min(columns - 24, Math.max(24, pane.columns + 1))
    return Math.max(1, dockColumns - 1)
  }

  function visibleOf(pane: PaneState): boolean {
    if (pane.personInitiated) return true
    const threshold = personRequested.has(askedKey(pane.owner, pane.id)) ? 110 : 144
    return pane.presentation.columns >= threshold
  }

  function placementResult(pane: PaneState): { isPlaced: boolean; reason?: string } {
    return pane.visible
      ? { isPlaced: true }
      : { isPlaced: false, reason: `Pane is waiting for sufficient terminal width (${pane.presentation.columns} columns)` }
  }

  function placementOf(presentation: ModUiPresentation): ModUiPlacement {
    return presentation.isFullscreen && presentation.columns >= 110 ? 'dock' : 'inline'
  }

  function snapshotPane(pane: PaneState): ModUiPane {
    const visible = pane.visible && pane.tree !== undefined
    return Object.freeze({
      id: pane.id,
      ...(clients ? { clients } : {}),
      title: pane.title,
      plugin: pane.plugin,
      owner: pane.owner,
      visible,
      shown: visible && pane.shown,
      placement: pane.placement,
      focused: visible && pane.focused,
      closeOnEscape: pane.closeOnEscape,
      holdToasts: pane.holdToasts,
      ...(pane.rows === undefined ? {} : { rows: pane.rows }),
      ...(pane.columns === undefined ? {} : { columns: pane.columns }),
      scrollOffset: pane.scrollOffset,
      bodyRows: pane.bodyRows,
      bodyColumns: bodyColumnsOf(pane),
      ...(pane.placement === 'inline' ? { bodyRowLimit: bodyRowsOf(pane) } : {}),
      revision,
      contentRows: pane.contentRows,
      ...(pane.focusedElement === undefined ? {} : { focusedElement: pane.focusedElement }),
      ...(pane.focusedElement === undefined || pane.focusedPlugin === undefined ? {} : { focusedPlugin: pane.focusedPlugin }),
      ...(pane.tree === undefined ? {} : { tree: pane.tree }),
      ...(pane.drawing === undefined ? {} : { drawing: pane.drawing }),
    })
  }

  function wakeFocusWaiters(): void {
    for (const resolve of focusWaiters) resolve()
  }

  function reconcileShown(preferred?: PaneState): void {
    for (const placement of ['dock', 'inline'] as const) {
      const panes = [...active.values()].filter(pane => pane.visible && pane.placement === placement)
      const selected = preferred?.visible && preferred.placement === placement
        ? preferred
        : panes.find(pane => pane.shown) ?? panes[0]
      for (const pane of active.values()) {
        if (pane.placement === placement) pane.shown = pane === selected
      }
    }
  }

  function publish(): void {
    reconcileShown()
    revision++
    snapshot = Object.freeze([...active.values()].map(snapshotPane))
    reconcileClients()
    wakeFocusWaiters()
    for (const listener of [...listeners]) notify(listener)
  }

  async function releaseLease(pane: Pick<PaneState, 'owner' | 'drawing'>): Promise<void> {
    if (pane.drawing === undefined) return
    const drawing = pane.drawing
    pane.drawing = undefined
    await releaseDrawing(pane.owner, drawing)
  }

  function renderInput(pane: PaneState): ModRenderInput {
    return Object.freeze({
      surface: 'terminal',
      component: 'Pane',
      requestId: pane.id,
      viewport: Object.freeze({
        columns: pane.presentation.columns,
        rows: pane.presentation.rows,
        isFullscreen: pane.presentation.isFullscreen,
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

  function scheduleRedraw(
    target: PaneState | ModRenderSite,
    schedules: WeakMap<object, RedrawSchedule>,
    interval: number,
    drawTarget: () => Promise<void>,
    current: () => boolean,
  ): Promise<void> {
    let schedule = schedules.get(target)
    if (!schedule) {
      schedule = { lastStarted: 0, running: 0, scheduled: false, waiters: [] }
      schedules.set(target, schedule)
    }
    const waiter = Promise.withResolvers<void>()
    schedule.waiters.push(waiter)
    wakeFocusWaiters()
    if (schedule.scheduled) return waiter.promise

    const start = () => {
      schedule!.timer = undefined
      if (schedule!.running) {
        schedule!.resume = start
        return
      }
      schedule!.scheduled = false
      schedule!.running++
      schedule!.lastStarted = performance.now()
      const waiters = schedule!.waiters.splice(0)
      const work = current() ? drawTarget() : Promise.resolve()
      void work.then(
        () => waiters.forEach(entry => entry.resolve()),
        error => waiters.forEach(entry => entry.reject(error)),
      ).finally(() => {
        schedule!.running--
        const resume = schedule!.resume
        schedule!.resume = undefined
        resume?.()
      })
    }
    const delay = Math.max(0, interval - (performance.now() - schedule.lastStarted))
    schedule.scheduled = true
    if (delay === 0) queueMicrotask(start)
    else schedule.timer = setTimeout(start, delay)
    return waiter.promise
  }

  function pendingPaneWork(pane: PaneState): Promise<void> | undefined {
    const schedule = paneRedraws.get(pane)
    const scheduled = schedule?.waiters.at(-1)?.promise
    if (scheduled) return scheduled
    return pendingDraws.get(pane)
  }

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

  function invalidatePane(pane: PaneState): Promise<void> {
    return scheduleRedraw(
      pane,
      paneRedraws,
      pane.shown ? shownRedrawInterval : normalRedrawInterval,
      () => redraw(pane),
      () => active.get(pane.id) === pane,
    )
  }

  function invalidateSite(site: (typeof sites extends Map<ModUiOwner, infer S> ? S : never)): Promise<void> {
    site.cancelPending()
    return scheduleRedraw(
      site,
      siteRedraws,
      shownRedrawInterval,
      () => site.redraw(),
      () => [...sites.values()].includes(site),
    )
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
          shown: false,
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
    pane.columns = spec.columns
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
        ['Button', 'Select', 'Input', 'Client'].includes(String(node.type)) &&
        props?.key === element &&
        (node.type === 'Client' ? (node.group as { plugin?: string } | undefined)?.plugin : press?.plugin) === plugin
      ) return true
    }
    for (const child of Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>)) {
      if (focusableNode(child, element, plugin, seen)) return true
    }
    return false
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
        : kind === 'link.press'
          ? 'Markdown'
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
    getClientSite(owner, id) {
      const site = clientSites.get(owner)
      return site?.id === id ? site : snapshot.find(pane => pane.owner === owner && pane.id === id)
    },
    async dispose() {
      await Promise.all([...sites.values()].map(site => site.dispose()))
    },
    async mount(initial, consumer) {
      const owner = {}
      let current: ModRenderInput | undefined
      let tree: unknown
      let drawing: number | undefined
      let disposed = false
      let attached = false
      let disposal: Promise<void> | undefined
      let queue = Promise.resolve()
      let requested: ModRenderInput | undefined
      let pendingDraw: AbortController | undefined
      let lastDraw = queue
      const instances = new Map<string, { node: any; handle: ModClientHandle; tree?: unknown }>()
      let resolveEngine: (ref: number) => ModInput = () => { throw new Error('Unknown Mod UI engine ref') }
      let syncing = false
      let paintingQueue = Promise.resolve()
      const expanded = (value: any, client?: string): any => {
        if (!value || typeof value !== 'object') return value
        if (value.type === 'Client') {
          const entry = instances.get(`${value.group.plugin}\0${value.props.key}`)
          return entry?.tree === undefined ? { type: 'Box', children: [] } : expanded(entry.tree, value.props.key)
        }
        return { ...value,
          ...(client && value.press ? { press: { ...value.press, client } } : {}),
          ...(Array.isArray(value.children) ? { children: value.children.map((child: unknown) => expanded(child, client)) } : {}),
        }
      }
      const renderTree = (value: unknown) => {
        const output = consumer.retainClients || consumer.externalClients ? value : expanded(value)
        if (consumer.surface !== 'terminal') freezeRenderTree(output)
        return consumer.render(
          output, drawing!, resolveEngine,
          consumer.retainClients ? new Map([...instances].map(([key, entry]) => [key, { handle: entry.handle, tree: entry.tree }])) : undefined,
        )
      }
      const paint = () => {
        const work = paintingQueue.then(async () => {
          if (!disposed && drawing !== undefined) await renderTree(tree)
        })
        paintingQueue = work.catch(() => {})
        return work
      }
      const syncClients = async () => {
        if (!clients || !current) return
        const descriptor: ModClientSite = { owner, id: current.requestId, visible: true, tree, drawing,
          surface: current.surface, component: current.component, clock: consumer.clientClock }
        clientSites.set(owner, descriptor)
        const nodes = new Map<string, any>()
        const visit = (value: any) => {
          if (!value || typeof value !== 'object') return
          if (value.type === 'Client') {
            const key = `${value.group.plugin}\0${value.props.key}`
            if (nodes.has(key)) throw new Error('Client key is already mounted in this drawing')
            nodes.set(key, value)
          } else if (Array.isArray(value.children)) value.children.forEach(visit)
        }
        visit(tree)
        if (consumer.externalClients) return
        for (const [key, entry] of instances) {
          if (!nodes.has(key) || nodes.get(key).props.module !== entry.node.props.module) {
            instances.delete(key)
            await entry.handle.dispose()
          }
        }
        reconcileClients()
        syncing = true
        try {
          for (const [key, node] of nodes) {
            if (disposed) break
            const entry = instances.get(key)
            if (entry) { entry.node = node; await entry.handle.update(descriptor, node) }
            else {
              const next = { node, handle: undefined as unknown as ModClientHandle, tree: undefined as unknown }
              instances.set(key, next)
              next.handle = clients.mount(descriptor, node, output => {
                if (disposed || instances.get(key) !== next) return
                next.tree = output
                if (!syncing) void paint().catch(() => site.dispose())
              })
              await next.handle.ready
              await next.handle.resize(current.viewport?.columns ?? 0, current.viewport?.rows ?? 0)
            }
          }
        } finally { syncing = false }
      }
      const control = (scope: { in?: string } | undefined, act: (handle: ModClientHandle) => Promise<void>) => {
        const work = queue.then(async () => {
          if (disposed) throw new Error('Mod UI render site is stale')
          const matches = [...instances.values()].filter(entry => scope?.in === undefined || entry.node.props.key === scope.in)
          if (matches.length !== 1) throw new Error(matches.length ? 'Client selection is ambiguous; specify in' : 'Client is not mounted')
          await act(matches[0]!.handle)
          await matches[0]!.handle.settled?.()
          await paintingQueue
        })
        queue = work.catch(() => {})
        return work
      }
      const clientId = consumer.clientId ?? `${consumer.surface}:default`
      if (typeof clientId !== 'string' || !clientId) throw new TypeError('Mod UI render clientId must be a non-empty string')
      const focusFor = async (
        actor: ModUiOwner,
        request: { plugin: string; element: string; origin: Exclude<ModUiOrigin, { kind: 'unload' }> },
        options: ModUiHostFocusOptions | undefined,
        host: boolean,
      ) => {
        const controller = consumer.focus
        if (disposed || !current || drawing === undefined || !controller)
          return { deny: 'no such focus site' }
        if (!controller.isHeldNow()) return { deny: 'that site does not hold the keyboard' }
        const expected = controller.holderNow()
        if (request.origin.kind === 'plugin' && expected && expected.plugin !== request.plugin)
          return { deny: "another plugin's element holds the keyboard" }
        if (!controller.hasElement(request.plugin, request.element))
          return { deny: 'no element of its own is drawn under that key' }
        const input = Object.freeze({
          component: current.component, requestId: current.requestId,
          plugin: request.plugin, element: request.element, origin: request.origin,
        })
        const result = await dispatch(actor, 'ui.focus', input, async rewritten => {
          if (disposed || options?.signal?.aborted || !controller.isHeldNow() || controller.holderNow() !== expected)
            return { deny: 'the focus moved meanwhile' }
          if (typeof rewritten.element !== 'string' ||
              !controller.hasElement(request.plugin, rewritten.element) ||
              !focusableNode(tree, rewritten.element, request.plugin))
            return { deny: 'no element of its own is drawn under that key' }
          const deny = controller.commit({ plugin: request.plugin, element: rewritten.element })
          return deny === undefined ? {} : { deny }
        }, {
          origin: request.origin, drawing, signal: options?.signal,
          ...(host && request.origin.kind === 'plugin' ? { automaticFocus: true as const } : {}),
          restoreInput: (rewritten, received) => ({
            component: received.component, requestId: received.requestId,
            plugin: received.plugin, element: rewritten.element, origin: received.origin,
          }),
        })
        const landed = controller.holderNow()
        const focused = !disposed && controller.isHeldNow()
        logForDebugging(`[ModsUI] ${JSON.stringify({ event: 'site-focus', component: input.component,
          requestId: input.requestId, plugin: input.plugin, element: input.element, origin: input.origin,
          focused, landed, result })}`)
        if (!host) return result
        return { ...(result as Record<string, unknown>), focused,
          element: focused ? landed?.element : undefined, plugin: focused ? landed?.plugin : undefined }
      }
      const site: ModRenderSite & {
        focusPlugin(owner: ModUiOwner, element: string, origin: Extract<ModUiOrigin, { kind: 'plugin' }>): Promise<unknown>
        redraw(): Promise<void>
        cancelPending(): void
        blit(plugin: string, input: {
          requestId: string; key: string; cells?: string; source?: unknown
          columns?: number; rows?: number
        }): Promise<unknown>
        update(input: ModRenderInput, force?: boolean): Promise<void>
      } = {
        focus(request, options) { return focusFor(owner, request, options, true) },
        focusPlugin(actor, element, origin) {
          return focusFor(actor, { plugin: pluginOf(actor), element, origin }, undefined, false)
        },
        key({ in: key, ...event }) { return control({ in: key }, handle => handle.key(event)) },
        pointer({ in: key, ...event }) { return control({ in: key }, handle => handle.pointer(event)) },
        resize({ in: key, columns, rows }) { return control({ in: key }, handle => handle.resize(columns, rows)) },
        post(data, scope) { return control(scope, handle => handle.post(data)) },
        advance(ms) {
          const work = queue.then(async () => {
            if (disposed) throw new Error('Mod UI render site is stale')
            if (consumer.clientClock !== 'manual') throw new Error('Client advance requires a manual clock')
            if (!Number.isFinite(ms) || ms < 0) throw new TypeError('Invalid Client advance')
            for (const entry of instances.values()) await entry.handle.advance(ms)
            await paintingQueue
          })
          queue = work.catch(() => {})
          return work
        },
        getTree(scope) {
          if (disposed) return undefined
          if (!scope?.in) return tree
          const matches = [...instances.values()].filter(entry => entry.node.props.key === scope.in)
          if (matches.length > 1) throw new Error('Client key is ambiguous')
          return matches[0]?.tree
        },
        cancelPending() { pendingDraw?.abort(new Error('ui.render: superseded')) },
        async redraw() {
          if (requested && !disposed) await site.update(requested, true)
        },
        async blit(plugin, input) {
          await queue
          if (disposed || !current || tree === undefined)
            return { deny: 'site is not open' }
          if (current.requestId !== input.requestId)
            return { deny: 'site is not open' }
          const target = blitNode(tree, plugin, input.key)
          if (!target) return { deny: 'no owned Raster or Image is mounted under that key' }
          const props = target.props as Record<string, unknown>
          if (input.columns !== undefined && input.columns !== props.columns ||
              input.rows !== undefined && input.rows !== props.rows)
            return { deny: 'mounted dimensions do not match' }
          const raster = target.type === 'Raster'
          if (raster !== (input.cells !== undefined) || raster === (input.source !== undefined))
            return { deny: 'blit payload kind does not match the mounted element' }
          if (!raster && consumer.surface !== 'terminal')
            return { deny: 'terminal image frames cannot be written' }
          const apply = async () => {
            if (disposed || !current || tree === undefined)
              return { deny: 'site is not open' }
            const latest = blitNode(tree, plugin, input.key)
            if (!latest) return { deny: 'no owned Raster or Image is mounted under that key' }
            const latestProps = latest.props as Record<string, unknown>
            if (latest.type !== target.type)
              return { deny: 'blit payload kind does not match the mounted element' }
            if (input.columns !== undefined && input.columns !== latestProps.columns ||
                input.rows !== undefined && input.rows !== latestProps.rows)
              return { deny: 'mounted dimensions do not match' }
            const replacement = Object.freeze({
              ...latest,
              props: Object.freeze({
                ...latestProps,
                ...(raster ? { cells: input.cells } : { source: input.source }),
              }),
            })
            const nextTree = replaceNode(tree, latest, replacement)
            validateTree?.(nextTree, current)
            await renderTree(nextTree)
            tree = nextTree
            const descriptor = clientSites.get(owner)
            if (descriptor) descriptor.tree = tree
            return {}
          }
          const serialize = () => {
            const work = queue.then(apply)
            queue = work.then(() => {}, () => {})
            return work
          }
          const shared = !raster && input.source !== null && typeof input.source === 'object' &&
            Object.hasOwn(input.source, 'shm')
          return shared
            ? serialize()
            : queueBlit(`site\0${clientId}\0${input.requestId}\0${plugin}\0${input.key}`, serialize)
        },
        update(input, force = false) {
          const request = structuredClone(force ? requested ?? current ?? input : input)
          try {
            if (disposed) throw new Error('Mod UI render site is stale')
            if (request.surface !== consumer.surface || !['terminal', 'desktop', 'mobile', 'vscode'].includes(request.surface))
              throw new TypeError('Mod UI render surface must match its consumer')
            if (!['AskUserQuestion', 'UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'ToolProgress', 'CommandOutput', 'Spinner', 'TurnDuration', 'InfoNotice', 'SessionMode', 'PromptHint', 'AbovePrompt', 'Pane'].includes(request.component))
              throw new TypeError('Unknown Mod UI render component')
            if (typeof request.requestId !== 'string' || !request.props || typeof request.props !== 'object' || Array.isArray(request.props))
              throw new TypeError('Mod UI render requires a requestId and props')
            if (request.component !== initial.component || request.requestId !== initial.requestId)
              throw new TypeError('Mod UI render site identity cannot change')
            if (request.viewport && (!Number.isInteger(request.viewport.columns) || request.viewport.columns < 1 ||
                !Number.isInteger(request.viewport.rows) || request.viewport.rows < 1 ||
                request.viewport.isFullscreen !== undefined && typeof request.viewport.isFullscreen !== 'boolean'))
              throw new TypeError('Invalid Mod UI render viewport')
          } catch (error) { return Promise.reject(error) }
          if (!force && request.requestId !== '' && requested && isDeepStrictEqual({...request, viewport: {...request.viewport, rows: undefined}},
              {...requested, viewport: {...requested.viewport, rows: undefined}})) {
            requested = request
            if (!pendingDraw && current) current = request
            return lastDraw
          }
          requested = request
          pendingDraw?.abort(new Error('ui.render: superseded'))
          const controller = new AbortController()
          pendingDraw = controller
          const work = queue.then(async () => {
            if (disposed || controller.signal.aborted) return
            const next = nextDrawing++
            const previous = drawing
            const previousTree = tree
            const previousInput = current
            const previousResolve = resolveEngine
            const previousClientSite = clientSites.get(owner)
            let painting = true
            let published = false
            try {
              if (!attached && !consumer.externalClients && request.surface !== 'terminal') {
                await attach?.({
                  surface: request.surface,
                  clientId,
                  ...(request.viewport === undefined ? {} : { viewport: structuredClone(request.viewport) }),
                }, consumer.signal)
                attached = true
              }
              const originals = new Map<number, ModInput>([[0, structuredClone(request.props)]])
              const refs = new Set([0])
              const validate = (tree: unknown) => validateTree?.(tree, request, refs)
              const result = await draw(owner, request, next, async input => {
                const ref = originals.size
                originals.set(ref, structuredClone(input.props as ModInput))
                refs.add(ref)
                return { type: 'engine', ref }
              }, validate, controller.signal)
              controller.signal.throwIfAborted()
              validate(result)
              if (request.surface !== 'terminal') freezeRenderTree(result)
              drawing = next
              tree = result
              current = request
              resolveEngine = ref => {
                if (disposed || !painting && drawing !== next || !originals.has(ref)) throw new Error('Unknown or stale Mod UI engine ref')
                return structuredClone(originals.get(ref)!)
              }
              await syncClients()
              controller.signal.throwIfAborted()
              await paint()
              controller.signal.throwIfAborted()
              published = true
              if (previous !== undefined) {
                await releaseDrawing(owner, previous)
              }
            } catch (error) {
              if (!published && drawing === next) {
                clientSites.delete(owner)
                await Promise.all([...instances.values()].map(entry => entry.handle.dispose()))
                instances.clear()
                drawing = previous
                tree = previousTree
                current = previousInput
                resolveEngine = previousResolve
                if (previousClientSite) clientSites.set(owner, previousClientSite)
              }
              if (!published) {
                if (pendingDraw === controller) requested = previousInput
                await releaseDrawing(owner, next)
              }
              if (controller.signal.aborted) {
                logForDebugging(`[ModsUI] ${JSON.stringify({ event: 'draw-cancelled', component: request.component, requestId: request.requestId, drawing: next, reason: controller.signal.reason?.message })}`)
                return
              }
              throw error
            } finally {
              painting = false
              if (pendingDraw === controller) pendingDraw = undefined
            }
          })
          lastDraw = work
          queue = work.catch(() => {})
          return work
        },
        async interact(expectedDrawing, callback, kind, element, value, scope) {
          validateCallback(callback)
          if (!['press', 'link.press', 'input.change', 'input.submit', 'select'].includes(kind)) throw new TypeError('Mod UI interaction kind is invalid')
          if (kind !== 'press' && typeof value !== 'string') throw new TypeError('Mod UI interaction value must be a string')
          const lease = drawing
          const client = scope?.in ?? callback.client
          if (client !== undefined) {
            if (disposed || lease !== expectedDrawing) throw new Error('Mod UI drawing callback is stale')
            const entry = instances.get(`${callback.plugin}\0${client}`)
            if (!entry || !interactiveNode(entry.tree, kind, element, callback)) throw new Error('Client callback is stale')
            await entry.handle.press(callback, kind, element, value)
            await entry.handle.settled?.()
            await paintingQueue
            return
          }
          if (disposed || lease === undefined || lease !== expectedDrawing || !current || !interactiveNode(tree, kind, element, callback))
            throw new Error('Mod UI drawing callback is stale')
          const input = {
            surface: current.surface, component: current.component, requestId: current.requestId,
            plugin: callback.plugin, element,
            ...(kind === 'press' ? {} : kind === 'link.press' ? {link:{href:value}} : kind === 'select' ? {value} : {value, kind: kind === 'input.submit' ? 'submit' : 'change'}),
          }
          return dispatch(owner, kind === 'press' || kind === 'link.press' ? 'ui.press' : kind === 'select' ? 'ui.select' : 'ui.input', input, async rewritten => {
            if (disposed || drawing !== lease) throw new Error('Mod UI drawing callback is stale')
            await invokeDrawing(owner, lease, callback.handle, [rewritten])
            return kind === 'press' || kind === 'link.press' ? {element: rewritten.element} : {element: rewritten.element, value: rewritten.value}
          }, {origin: {kind:'person'}, drawing: lease})
        },
        dispose() {
          if (disposal) return disposal
          disposed = true
          consumer.signal?.removeEventListener('abort', abortSite)
          pendingDraw?.abort(new Error('ui.render: superseded'))
          clientSites.delete(owner)
          const stopping = Promise.all([...instances.values()].map(entry => entry.handle.dispose()))
          disposal = (async () => {
            await queue
            await stopping
            await paintingQueue
            instances.clear()
            try {
              if (drawing !== undefined) {
                const previous = drawing
                drawing = undefined
                await releaseDrawing(owner, previous)
              }
            } finally {
              try { if (attached) await detach?.({surface:consumer.surface,clientId,reason:'detach'}, consumer.signal) }
              finally {
                attached = false
                try { await consumer.unmount() }
                finally { sites.delete(owner) }
              }
            }
          })()
          return disposal
        },
      }
      const abortSite = () => { void site.dispose().catch(error => logForDebugging(`[ModsUI] ${String(error)}`)) }
      siteInputs.set(site, structuredClone(initial))
      sites.set(owner, site)
      consumer.signal?.addEventListener('abort', abortSite, { once: true })
      try {
        consumer.signal?.throwIfAborted()
        const first = site.update(initial)
        consumer.onMount?.(site)
        await first
        return site
      }
      catch (error) { await site.dispose(); throw error }
    },
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
          if (origin.kind === 'person') {
            personRequested.add(askedKey(owner, spec.id))
            onAskedChange?.(pluginOf(owner), spec.id, true)
          }
          const committed = activeOwners.has(owner)
          const store = committed
            ? active
            : (candidates.get(owner) ?? new Map<string, PaneState>())
          if (!committed && !candidates.has(owner)) candidates.set(owner, store)
          const existing = store.get(spec.id)
          if (committed && existing && !ownsPane(owner, existing))
            throw new Error(`Mod UI pane ${spec.id} is already owned by another activation`)
          if (!committed) {
            const pane = openState(owner, existing, spec, origin, presentation)
            store.set(spec.id, pane)
            return placementResult(pane)
          }

          if (!existing) {
            const pane = openState(owner, undefined, spec, origin, presentation)
            active.set(spec.id, pane)
            if (origin.kind === 'person') reconcileShown(pane)
            if (!pane.visible) {
              publish()
              return placementResult(pane)
            }
            try {
              await redraw(pane)
            } catch (error) {
              publish()
              throw error
            }
            return placementResult(pane)
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
            return { isPlaced: false, reason: 'Pane open was superseded or closed' }
          }
          openGenerations.delete(key)
          if (existing && active.get(spec.id) !== existing) {
            await releaseLease(pane).catch(() => {})
            return { isPlaced: false, reason: 'Pane open was superseded or closed' }
          }
          if (spec.focus === true) {
            for (const current of active.values()) current.focused = false
          }
          active.set(spec.id, pane)
          if (pane.focused || origin.kind === 'person') reconcileShown(pane)
          publish()
          if (existing) {
            existing.drawGeneration++
            await releaseLease(existing).catch(() => {})
          }
          return placementResult(pane)
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
          if (origin.kind === 'person') {
            personRequested.delete(askedKey(pane.owner, id))
            onAskedChange?.(pane.plugin, id, false)
          }
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
        for (const site of sites.values()) {
          const result = await site.blit(plugin, input)
          if ((result as { deny?: string }).deny !== 'site is not open') return result
        }
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
      if (target.type === 'Image' && pane.shown === false)
        return { deny: 'terminal image frames cannot be written' }
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
          if (latest.type === 'Image' && pane.shown === false)
            return { deny: 'terminal image frames cannot be written' }
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

    async invalidateInstance(instance) {
      const work: Promise<void>[] = []
      if (instance.surface === 'terminal' && instance.component === 'Pane') {
        const pane = active.get(instance.requestId)
        if (pane) work.push(invalidatePane(pane))
      }
      for (const site of sites.values()) {
        const input = siteInputs.get(site)!
        if (input.surface === instance.surface && input.component === instance.component && input.requestId === instance.requestId)
          work.push(invalidateSite(site))
      }
      await Promise.all(work)
    },

    async invalidate(owner, event) {
      validateOwner(owner)
      if (event !== invalidatableRenderEvent || !activeOwners.has(owner)) return
      await Promise.all([
        ...[...active.values()].map(invalidatePane),
        ...[...sites.values()].map(invalidateSite),
      ])
    },

    async render(rawPresentation, { nativeSites = true } = {}) {
      const presentation = rawPresentation === undefined ? undefined : validatePresentation(rawPresentation)
      const work: Promise<void>[] = [...sites.values()]
        .filter(site => nativeSites || ['Pane', 'AbovePrompt'].includes(siteInputs.get(site)?.component ?? ''))
        .map(site => site.redraw())
      let changed = false
      for (const pane of active.values()) {
        if (presentation) changed = updatePresentation(pane, presentation) || changed
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

    async focusHost(owner, input, presentation, options = {}) {
      validateOwner(owner)
      const pane = active.get(input.requestId)
      if (!pane || pane.owner !== owner) return { deny: 'site is not current', focused: false }
      const request = Object.freeze({ ...input })
      automaticFocusRequests.set(request, {
        ...options,
        expectedElement: Object.hasOwn(options, 'expectedElement') ? options.expectedElement : pane.focusedElement,
      })
      let result: unknown
      try { result = await ui.focus(owner, request, presentation) }
      finally { automaticFocusRequests.delete(request) }
      const current = ui.getSnapshot().find(pane => pane.id === input.requestId && pane.owner === owner)
      const focused = Boolean(current?.visible && current.shown !== false && current.tree !== undefined && current.focused)
      return {
        ...(result as Record<string, unknown>),
        focused,
        element: focused ? current?.focusedElement : undefined,
        plugin: focused ? current?.focusedPlugin : undefined,
        ...(current ? { revision: current.revision } : {}),
      }
    },

    async focus(owner, request, rawPresentation) {
      validateOwner(owner)
      const automatic = automaticFocusRequests.get(request)
      const person = request.origin.kind === 'person'
      const pane = active.get(request.requestId)
      if (!pane && request.origin.kind === 'plugin' && request.element !== undefined) {
        const matches = [...sites.values()].filter(site => siteInputs.get(site)?.requestId === request.requestId)
        if (matches.length !== 1) return { deny: matches.length ? 'focus site is ambiguous' : "not this plugin's site" }
        return matches[0]!.focusPlugin(owner, request.element, request.origin)
      }
      if (!pane) return { deny: 'site is not open', ...(person ? { focused: false } : {}) }
      if (request.origin.kind === 'plugin' && !ownsPane(owner, pane))
        return { deny: 'site belongs to another plugin' }
      if ((person || automatic) && rawPresentation !== undefined) {
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
        ...(request.element === undefined ? {} : { plugin: automatic && request.origin.kind === 'plugin' ? request.origin.name : pane.plugin, element: request.element }),
        origin: request.origin,
      })
      const result = await dispatch(owner, 'ui.focus', input, async rewritten => {
        if (active.get(pane.id) !== pane || !automatic && generation !== personFocusGeneration)
          return { deny: 'another move landed first' }
        if (automatic?.signal?.aborted) return { deny: 'the move was abandoned' }
        if (!pane.visible || !visibleOf(pane) || pane.tree === undefined)
          return { deny: 'site is not visible' }
        const presentation = pane.presentation
        const canFocus = person && (request.element !== undefined || pane.shown === false)
          ? presentation.composerEmpty && !presentation.hasDialog && !presentation.keyboardOwned
          : automatic
            ? pane.focused && presentation.composerEmpty && !presentation.hasDialog && !presentation.keyboardOwned
            : person || pane.focused
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
        if (automatic && nextElement === input.element && pane.focusedElement !== automatic.expectedElement)
          return { deny: 'the focus moved meanwhile' }
        if (input.element === undefined && nextElement !== undefined ||
            input.element !== undefined && (typeof nextElement !== 'string' || nextElement.length === 0))
          throw new TypeError('Mod UI focus cannot add or remove an element')
        if (nextElement !== undefined &&
            !focusableNode(pane.tree, nextElement as string, input.plugin as string))
          return { deny: `no element of ${input.plugin} is drawn under that key` }
        const relinquish = nextElement === undefined && person && pane.shown !== false
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
        const nextPlugin = nextElement === undefined ? undefined : input.plugin as string
        if (pane.focusedElement !== nextElement || pane.focusedPlugin !== nextPlugin || pane.focused !== focused) {
          pane.focusedPlugin = nextPlugin
          pane.focusedElement = nextElement as string | undefined
          pane.focused = focused
          changed = true
        }
        if (person && pane.visible && !pane.shown) {
          reconcileShown(pane)
          changed = true
        }
        if (changed) publish()
        return {}
      }, {
        origin: request.origin,
        ...(automatic ? { automaticFocus: true as const, signal: automatic.signal } : {}),
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
        const drawing = pendingPaneWork(pane)
        if (!drawing) break
        const drawGeneration = pane.drawGeneration
        const changed = Promise.withResolvers<void>()
        focusWaiters.add(changed.resolve)
        try {
          await Promise.race([drawing, changed.promise])
        } catch (error) {
          await Promise.resolve()
          const superseded = pendingPaneWork(pane)
          if (active.get(pane.id) === pane && pane.visible && pane.focused &&
              generation === personFocusGeneration && drawGeneration === pane.drawGeneration &&
              (!superseded || superseded === drawing))
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
      if (!['press', 'link.press', 'input.change', 'input.submit', 'select'].includes(kind))
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
      const event = kind === 'press' || kind === 'link.press'
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
          : kind === 'link.press'
            ? { link: { href: value } }
            : kind === 'select'
              ? { value }
              : { kind: kind === 'input.submit' ? 'submit' : 'change', value }),
      })
      return dispatch(pane.owner, event, input, async rewritten => {
        if (active.get(id) !== pane || pane.drawing !== drawing)
          throw new Error('Mod UI drawing callback is stale')
        await invokeDrawing(pane.owner, drawing, callback.handle, [rewritten])
        return kind === 'press' || kind === 'link.press'
          ? { element: rewritten.element }
          : { element: rewritten.element, value: rewritten.value }
      }, { origin: { kind: 'person' } })
    },

    reportMetrics(id, metrics) {
      const pane = active.get(id)
      if (!pane) return
      if (
        !Number.isInteger(metrics.bodyRows) || metrics.bodyRows < 0 ||
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
      logForDebugging(`[ModsUI] ${JSON.stringify({ event: 'metrics', plugin: pane.plugin, id, drawing: pane.drawing, placement: pane.placement, bodyRows: metrics.bodyRows, contentRows: metrics.contentRows, scrollOffset })}`)
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
        const preferred = prepared.find(pane => pane.focused)
        reconcileShown(preferred)
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
