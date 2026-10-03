import React from 'react'
import { ModsPane } from './ModsPane.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import type { ModRenderSite, ModUi, ModUiPane } from '../services/mods/ui.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'

const REQUEST_ID = 'above-prompt'

type Props = {
  ui?: ModUi
  hasSurvey: boolean
  isWorking: boolean
  view: Readonly<{ agentId?: string }>
  canFocus: boolean
  onFocusChange?(focused: boolean): void
  onError?(error: unknown): void
}

type Frame = {
  tree: unknown
  drawing: number
  clients?: ModUiPane['clientBindings']
}

function materializeHostContinuations(
  value: unknown,
  resolveEngine: (ref: number) => unknown,
): unknown {
  if (!value || typeof value !== 'object') return value
  const element = value as { type?: unknown; ref?: unknown; children?: unknown }
  if (element.type === 'engine') {
    resolveEngine(element.ref as number)
    return { type: 'Box', children: [] }
  }
  if (element.type === 'Client' || !Array.isArray(element.children)) return value
  return { ...value, children: element.children.map(child => materializeHostContinuations(child, resolveEngine)) }
}

export function ModsAbovePrompt({
  ui,
  hasSurvey,
  isWorking,
  view,
  canFocus,
  onFocusChange,
  onError,
}: Props): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const [frame, setFrame] = React.useState<Frame>()
  const [focused, setFocused] = React.useState(false)
  const [scrollOffset, setScrollOffset] = React.useState(0)
  const [contentRows, setContentRows] = React.useState(0)
  const siteRef = React.useRef<ModRenderSite | undefined>(undefined)
  const bodyRows = Math.max(0, rows - 1)
  const maxOffset = Math.max(0, contentRows - bodyRows)
  const effectiveOffset = Math.min(scrollOffset, maxOffset)
  const latest = React.useRef({ onError, onFocusChange })
  latest.current = { onError, onFocusChange }

  const input = React.useMemo(() => ({
    surface: 'terminal' as const,
    component: 'AbovePrompt' as const,
    requestId: REQUEST_ID,
    viewport: { columns, rows, isFullscreen: isFullscreenEnvEnabled() },
    props: {
      hasSurvey,
      isWorking,
      maxRows: rows,
      bodyColumns: columns,
      scroll: { offset: effectiveOffset, bodyRows },
      view,
    },
  }), [bodyRows, columns, effectiveOffset, hasSurvey, isWorking, rows, view])

  const latestInput = React.useRef(input)
  latestInput.current = input

  React.useEffect(() => {
    if (!ui) {
      siteRef.current = undefined
      setFrame(undefined)
      return
    }
    let active = true
    let mounted: ModRenderSite | undefined
    void ui.mount(input, {
      surface: 'terminal',
      retainClients: true,
      render(tree, drawing, resolveEngine, clients) {
        if (!active) return
        const element = tree as { type?: unknown; ref?: unknown } | null
        if (element?.type === 'engine') {
          resolveEngine(element.ref as number)
          setFrame(undefined)
          return
        }
        setFrame({ tree: materializeHostContinuations(tree, resolveEngine), drawing, clients })
      },
      unmount() {
        if (active) setFrame(undefined)
      },
    }).then(site => {
      if (!active) {
        void site.dispose().catch(error => latest.current.onError?.(error))
        return
      }
      mounted = site
      siteRef.current = site
      if (latestInput.current !== input)
        void site.update(latestInput.current).catch(error => latest.current.onError?.(error))
    }).catch(error => latest.current.onError?.(error))
    return () => {
      active = false
      if (siteRef.current === mounted) siteRef.current = undefined
      void mounted?.dispose().catch(error => latest.current.onError?.(error))
    }
    // The render site identity is fixed. Prop and resize changes use update below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui])

  React.useEffect(() => {
    const site = siteRef.current
    if (!site) return
    void site.update(input).catch(error => latest.current.onError?.(error))
  }, [input])

  React.useEffect(() => {
    if (canFocus && !hasSurvey && frame) return
    setFocused(false)
    latest.current.onFocusChange?.(false)
  }, [canFocus, hasSurvey, frame])

  React.useEffect(() => () => {
    latest.current.onFocusChange?.(false)
  }, [])

  React.useEffect(() => {
    if (effectiveOffset !== scrollOffset) setScrollOffset(effectiveOffset)
  }, [effectiveOffset, scrollOffset])

  if (!frame) return null

  const pane: ModUiPane = {
    id: REQUEST_ID,
    title: '',
    plugin: 'host',
    owner: siteRef,
    visible: true,
    shown: true,
    placement: 'inline',
    focused,
    closeOnEscape: false,
    holdToasts: false,
    scrollOffset: effectiveOffset,
    bodyRows: Math.max(1, Math.min(rows, contentRows || 1)),
    bodyColumns: columns,
    revision: frame.drawing,
    contentRows,
    tree: frame.tree,
    clientBindings: frame.clients,
    drawing: frame.drawing,
  }

  return <ModsPane
    pane={pane}
    canFocus={canFocus && !hasSurvey}
    onInteract={(_pane, drawing, callback, kind, element, value) => {
      const site = siteRef.current
      if (!site) return Promise.reject(new Error('Mod UI AbovePrompt site is unavailable'))
      return site.interact(drawing, callback, kind, element, value)
    }}
    onClose={async () => {}}
    onFocus={async (_pane, element) => {
      const next = element !== undefined
      setFocused(next)
      latest.current.onFocusChange?.(next)
      return { focused: next, element }
    }}
    onScroll={async (_pane, by) => {
      setScrollOffset(current => Math.max(0, Math.min(maxOffset, current + by)))
    }}
    onReportMetrics={(_pane, metrics) => {
      setContentRows(metrics.contentRows)
    }}
    onError={onError}
  />
}
