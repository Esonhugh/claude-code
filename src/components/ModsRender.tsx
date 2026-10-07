import React from 'react'
import { Box, type DOMElement } from '../ink.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import { getFocusManager } from '../ink/focus.js'
import { subscribeFrame } from '../ink/dom.js'
import { ModsRenderContext } from '../context/modsRenderContext.js'
import type { ModsSession } from '../services/mods/session.js'
import type { ModInput } from '../services/mods/types.js'
import type { ModClientBinding, ModRenderInput, ModRenderSite, ModUiFocusTarget, ModUiPane } from '../services/mods/ui.js'
import { getModOnScreen, sameModOnScreen, type ModOnScreen } from '../services/mods/renderGeometry.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { logForDebugging } from '../utils/debug.js'
import { ModRenderTree, validateModRenderTree } from './ModsPane.js'

const noSubscribe = () => () => {}
const noSnapshot = () => undefined

export function ModsRenderProvider({ session, children }: { session?: ModsSession; children: React.ReactNode }): React.ReactNode {
  const value = React.useSyncExternalStore(session?.renderHooks.subscribe ?? noSubscribe, session?.renderHooks.getSnapshot ?? noSnapshot)
  return <ModsRenderContext value={value}>{children}</ModsRenderContext>
}

type Frame = {
  owner: object
  tree: unknown
  drawing: number
  engines: ReadonlyMap<number, ModInput>
  engineRefs: ReadonlySet<number>
  clients?: ReadonlyMap<string, ModClientBinding>
}

class DrawingBoundary extends React.Component<{
  frame: Frame
  fallback: React.ReactNode
  children: React.ReactNode
}, { failed: boolean; frame: Frame }> {
  state = { failed: false, frame: this.props.frame }
  static getDerivedStateFromError() { return { failed: true } }
  static getDerivedStateFromProps(props: { frame: Frame }, state: { frame: Frame }) {
    return props.frame === state.frame ? null : { failed: false, frame: props.frame }
  }
  componentDidCatch(error: unknown) { report(error) }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

function report(error: unknown): void {
  logForDebugging(`[ModsRender] ${error instanceof Error ? error.message : String(error)}`)
}

function collectEngines(tree: unknown, resolve: (ref: number) => ModInput): ReadonlyMap<number, ModInput> {
  const engines = new Map<number, ModInput>()
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const node = value as { type?: unknown; ref?: number; children?: unknown[] }
    if (node.type === 'engine') engines.set(node.ref!, resolve(node.ref!))
    else if (node.type !== 'Client') node.children?.forEach(visit)
  }
  visit(tree)
  return engines
}

/** A native render site. Host continuations stay React nodes and never cross the Worker boundary. */
export function ModsRender({ input: received, children: native }: {
  input: ModRenderInput
  children: (props: ModInput) => React.ReactNode
}): React.ReactNode {
  const context = React.useContext(ModsRenderContext)
  const runtime = context?.runtime
  const size = React.useContext(TerminalSizeContext)
  const fullscreen = isFullscreenEnvEnabled()
  const columns = size?.global?.conversationColumns ?? size?.columns
  const rows = size?.global?.rows ?? size?.rows
  const viewport = React.useMemo(() => columns === undefined || rows === undefined ? undefined : { columns, rows, isFullscreen: fullscreen }, [columns, rows, fullscreen])
  const [onScreen, setOnScreen] = React.useState<ModOnScreen | null | undefined>()
  const props = React.useMemo(() => fullscreen && onScreen !== undefined ? { ...received.props, onScreen } : received.props, [received.props, fullscreen, onScreen])
  const input = React.useMemo(() => ({ ...received, props, ...(viewport ? { viewport } : {}) }), [received, props, viewport])
  const matched = runtime?.renderHooks.matches(input) ?? false
  const root = React.useRef<DOMElement>(null)
  const focusElements = React.useRef(new Map<string, Set<DOMElement>>())
  const keyElements = React.useRef(new Map<string, { plugin: string; key: string; elements: Set<DOMElement> }>())
  const owner = React.useMemo(() => ({}), [runtime, received.component, received.requestId, matched])
  const [frameState, setFrame] = React.useState<Frame>()
  const frame = frameState?.owner === owner ? frameState : undefined
  const [siteState, setSite] = React.useState<{ site: ModRenderSite; owner: object }>()
  const site = siteState?.owner === owner ? siteState.site : undefined
  const [failed, setFailed] = React.useState(false)
  const current = React.useRef({ input, frame, site, native, owner })
  current.current = { input, frame, site, native, owner }
  const find = React.useCallback((target: ModUiFocusTarget) => {
    const entry = keyElements.current.get(`${target.plugin}\0${target.element}`)
    return [...(entry?.elements ?? [])].find(element => element.yogaNode?.getComputedHeight())
  }, [])
  const heldTarget = React.useRef<ModUiFocusTarget | undefined>(undefined)
  const holder = React.useCallback((): ModUiFocusTarget | undefined => {
    if (!root.current) return undefined
    const active = getFocusManager(root.current).activeElement
    for (const entry of keyElements.current.values()) {
      for (const element of entry.elements) {
        let node = active
        while (node && node !== element) node = node.parentNode ?? null
        if (node) {
          const previous = heldTarget.current
          if (previous?.plugin !== entry.plugin || previous.element !== entry.key) heldTarget.current = { plugin: entry.plugin, element: entry.key }
          return heldTarget.current
        }
      }
    }
    heldTarget.current = undefined
    return undefined
  }, [])

  React.useEffect(() => {
    if (!runtime || !matched) return
    let alive = true
    let mounted: ModRenderSite | undefined
    setFrame(undefined)
    setFailed(false)
    const ready = runtime.ui.mount(current.current.input, {
      surface: 'terminal', retainClients: true,
      focus: {
        isHeldNow: () => holder() !== undefined,
        holderNow: holder,
        hasElement: (plugin, element) => find({ plugin, element }) !== undefined,
        commit: target => {
          const element = find(target)
          if (element && root.current) getFocusManager(root.current).focus(element)
          return element ? undefined : 'no element of its own is drawn under that key'
        },
      },
      render(tree, drawing, resolve, clients) {
        if (!alive) return
        const engines = collectEngines(tree, resolve)
        const engineRefs = new Set(engines.keys())
        validateModRenderTree(tree, 'terminal', engineRefs)
        setFrame({ owner, tree, drawing, engines, engineRefs, clients })
        setFailed(false)
      },
      unmount() { if (alive) setFrame(undefined) },
    }).then(async result => {
      mounted = result
      if (!alive) { await result.dispose(); return }
      setSite({ site: result, owner })
      await result.update(current.current.input)
    }).catch(error => { if (alive) { report(error); setFailed(true) } })
    return () => {
      alive = false
      setSite(undefined)
      // A site that finishes mounting after unmount disposes itself above.
      if (mounted) void mounted.dispose().catch(report)
      else void ready
    }
  }, [runtime, matched, received.component, received.requestId, find, holder])
  React.useEffect(() => { if (site && matched) void site.update(input).catch(report) }, [site, input, matched])
  React.useEffect(() => {
    if (!matched || !fullscreen || !root.current) return
    const update = () => {
      const next = getModOnScreen(root.current)
      if (next !== undefined) setOnScreen(previous => sameModOnScreen(previous, next) ? previous : next)
    }
    update()
    return subscribeFrame(root.current, update)
  }, [matched, fullscreen, owner])

  const pane: ModUiPane = {
    id: received.requestId, title: '', plugin: '', owner, visible: true, shown: true,
    placement: 'inline', focused: true, closeOnEscape: false, holdToasts: false,
    scrollOffset: 0, bodyRows: rows ?? 0, bodyColumns: columns ?? 0, contentRows: 0,
    revision: frame?.drawing ?? 0, tree: frame?.tree, drawing: frame?.drawing, clientBindings: frame?.clients,
  }
  const latestPane = React.useRef(pane)
  latestPane.current = pane
  const onFocus = React.useCallback(async (_pane: ModUiPane, element?: string) => {
    const live = current.current
    if (!live.site || live.owner !== _pane.owner || live.frame?.drawing !== _pane.drawing || !element) return
    const target = holder() ?? [...keyElements.current.values()].find(entry => entry.key === element)
    if (target) return live.site.focus({ plugin: target.plugin, element, origin: { kind: 'person' } })
  }, [holder])

  if (!matched) return native(received.props)
  const fallback = native(received.props)
  return <Box ref={root} flexDirection="column">
    {frame ? <DrawingBoundary frame={frame} fallback={fallback}>
      <ModRenderTree tree={frame.tree} engineRefs={frame.engineRefs} pane={pane}
        focusElements={focusElements} keyElements={keyElements} currentPane={() => latestPane.current}
        renderEngine={ref => native(frame.engines.get(ref)!)}
        onInteract={async (_pane, drawing, callback, kind, element, value) => {
          const live = current.current
          if (_pane.owner !== live.owner || drawing !== live.frame?.drawing) return
          return live.site?.interact(drawing, callback, kind, element, value)
        }} onFocus={onFocus} onError={report} />
    </DrawingBoundary> : failed ? fallback : null}
  </Box>
}
