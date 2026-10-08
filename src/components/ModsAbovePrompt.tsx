import React from 'react'
import { Box, Button, Text, type DOMElement } from '../ink.js'
import { getFocusManager } from '../ink/focus.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { ModsPane, type ModsPaneFocusHandle } from './ModsPane.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import type { ModRenderSite, ModUi, ModUiPane, ModUiFocusTarget } from '../services/mods/ui.js'
import { ModsBandBudgetContext } from '../context/modsPaneHostContext.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'

const REQUEST_ID = 'above-prompt'
const MARK_COLUMNS = 5
const EMPTY_PANES: readonly ModUiPane[] = Object.freeze([])
let bandCollapsed = false

type Props = {
  ui?: ModUi
  hasSurvey: boolean
  isWorking: boolean
  view: Readonly<{ agentId?: string }>
  canFocus: boolean
  composerValue?: string
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
  composerValue,
  onFocusChange,
  onError,
}: Props): React.ReactNode {
  const terminalSize = useTerminalSize()
  const panes = React.useSyncExternalStore(ui?.subscribe ?? (() => () => {}), ui?.getSnapshot ?? (() => EMPTY_PANES))
  const paneHeld = panes.some(pane => pane.visible && pane.shown !== false && pane.focused)
  const { columns, rows } = terminalSize
  const hostBudget = React.useContext(ModsBandBudgetContext)
  const availableRows = Math.max(0, hostBudget ?? rows)
  const [settledRows, setSettledRows] = React.useState(availableRows)
  React.useEffect(() => {
    if (settledRows === availableRows) return
    const timer = setTimeout(() => setSettledRows(availableRows), 150)
    return () => clearTimeout(timer)
  }, [availableRows, settledRows])
  const [frame, setFrame] = React.useState<Frame>()
  const [focused, setFocused] = React.useState(false)
  const heldNow = React.useRef(false)
  const holderNow = React.useRef<ModUiFocusTarget | undefined>(undefined)
  const heldComposer = React.useRef(composerValue)
  const controls = React.useRef<ModsPaneFocusHandle>(null)
  const [focusTarget, setFocusTarget] = React.useState<ModUiFocusTarget>()
  const [collapsed, setCollapsed] = React.useState(() => bandCollapsed)
  const collapsedNow = React.useRef(bandCollapsed)
  const collapsedRoot = React.useRef<DOMElement>(null)
  const shortcut = useShortcutDisplay('abovePrompt:toggle', 'Chat', 'ctrl+x ctrl+a')
  const [scrollOffset, setScrollOffset] = React.useState(0)
  const [contentRows, setContentRows] = React.useState(0)
  const siteRef = React.useRef<ModRenderSite | undefined>(undefined)
  const bodyRows = Math.max(0, settledRows - 1)
  const hasCue = contentRows > availableRows
  const windowRows = Math.max(0, availableRows - (hasCue ? 1 : 0))
  const bodyColumns = Math.max(0, columns - MARK_COLUMNS)
  const maxOffset = Math.max(0, contentRows - windowRows)
  const effectiveOffset = Math.min(scrollOffset, maxOffset)
  const latest = React.useRef({ onError, onFocusChange, canFocus, hasSurvey, composerValue, frame, hasCue })
  latest.current = { onError, onFocusChange, canFocus, hasSurvey, composerValue, frame, hasCue }
  const hold = React.useCallback((value: boolean, target?: ModUiFocusTarget) => {
    if (!value && heldNow.current) controls.current?.forget()
    if (value && !heldNow.current) heldComposer.current = latest.current.composerValue
    heldNow.current = value
    holderNow.current = value ? target : undefined
    setFocusTarget(holderNow.current)
    setFocused(value)
    latest.current.onFocusChange?.(value)
  }, [])

  const input = React.useMemo(() => ({
    surface: 'terminal' as const,
    component: 'AbovePrompt' as const,
    requestId: REQUEST_ID,
    viewport: { columns, rows, isFullscreen: isFullscreenEnvEnabled() },
    props: {
      hasSurvey,
      isWorking,
      maxRows: settledRows,
      bodyColumns,
      scroll: { offset: effectiveOffset, bodyRows },
      view,
    },
  }), [bodyRows, bodyColumns, columns, effectiveOffset, hasSurvey, isWorking, rows, settledRows, view])

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
      focus: {
        isHeldNow: () => active && heldNow.current && !collapsedNow.current && latest.current.canFocus &&
          !latest.current.hasSurvey && !ui.getSnapshot().some(pane => pane.visible && pane.focused) &&
          heldComposer.current === latest.current.composerValue,
        holderNow: () => holderNow.current,
        hasElement: (plugin, element) => !collapsedNow.current && controls.current?.hasElement(plugin, element) === true,
        commit: target => {
          if (!active || !heldNow.current || !latest.current.canFocus ||
              heldComposer.current !== latest.current.composerValue ||
              !controls.current?.hasElement(target.plugin, target.element))
            return 'the focus moved meanwhile'
          hold(true, target)
        },
      },
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
      heldNow.current = false
      holderNow.current = undefined
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
    if (canFocus && !hasSurvey && frame && !collapsed && !paneHeld &&
        (!heldNow.current || heldComposer.current === composerValue)) return
    hold(false)
  }, [canFocus, hasSurvey, frame, collapsed, hold, composerValue, paneHeld])

  React.useEffect(() => () => {
    latest.current.onFocusChange?.(false)
  }, [])

  React.useEffect(() => {
    if (effectiveOffset !== scrollOffset) setScrollOffset(effectiveOffset)
  }, [effectiveOffset, scrollOffset])

  const toggle = React.useCallback(() => {
    if (!frame) return false
    collapsedNow.current = !collapsedNow.current
    bandCollapsed = collapsedNow.current
    setCollapsed(collapsedNow.current)
    hold(false)
  }, [frame, hold])
  useKeybinding('abovePrompt:toggle', toggle, { context: 'Chat', isActive: frame !== undefined, capture: true })
  useKeybinding('abovePrompt:focus', () => {
    if (hasSurvey || !canFocus) return false
    const panes = ui?.getSnapshot().filter(pane => pane.visible) ?? []
    if (panes.some(pane => pane.focused)) {
      hold(false)
      ui?.cyclePaneFocus(latest.current.composerValue)
      return
    }
    const canEnter = frame && !collapsedNow.current &&
      (controls.current?.hasNext() || hasCue)
    // Choose the site on receipt; only control moves wait for earlier replies.
    if (canEnter && (controls.current?.hasNext(holderNow.current) || panes.length === 0)) {
      const wasHeld = heldNow.current
      if (!wasHeld) {
        hold(true)
        controls.current?.focusBody()
      }
      void controls.current?.next(!wasHeld, panes.length === 0)
      return
    }
    if (!panes.length) return false
    hold(false)
    ui?.cyclePaneFocus(latest.current.composerValue)
  }, { context: 'Chat', capture: true })

  if (!frame) return null
  const more = hasCue && <Text dimColor wrap="truncate-end">{[
    effectiveOffset > 0 ? `↑ ${effectiveOffset} more` : '',
    maxOffset > effectiveOffset ? `↓ ${maxOffset - effectiveOffset} more` : '',
  ].filter(Boolean).join(' · ')}</Text>
  if (collapsed) return <Box ref={collapsedRoot} flexDirection="column" flexShrink={0} maxHeight={availableRows} overflowY="hidden"
    onClick={event => {
      event.stopImmediatePropagation()
      if (collapsedRoot.current) getFocusManager(collapsedRoot.current).blur()
    }}>
    <Button tabIndex={-1} flexShrink={0} alignSelf="flex-start" onAction={toggle}>
      {({ hovered }) => <Text dimColor inverse={hovered} wrap="truncate-end">
        {`▸ plugin panel hidden · ${shortcut} or click to show`}
      </Text>}
    </Button>
    {more}
  </Box>

  const pane: ModUiPane = {
    id: REQUEST_ID,
    title: '',
    plugin: 'host',
    owner: siteRef,
    visible: true,
    shown: true,
    placement: 'inline',
    focused,
    focusedElement: focusTarget?.element,
    focusedPlugin: focusTarget?.plugin,
    closeOnEscape: false,
    holdToasts: false,
    scrollOffset: effectiveOffset,
    bodyRows: windowRows,
    bodyRowLimit: windowRows,
    bodyColumns,
    revision: frame.drawing,
    contentRows,
    tree: frame.tree,
    clientBindings: frame.clients,
    drawing: frame.drawing,
  }

  return <Box flexDirection="column" flexShrink={0} maxHeight={availableRows} overflowY="hidden"><ModsPane
    pane={pane}
    focusRef={controls}
    isWorking={isWorking}
    onReleaseFocus={() => hold(false)}
    canFocus={canFocus && !hasSurvey}
    onInteract={(_pane, drawing, callback, kind, element, value) => {
      const site = siteRef.current
      if (!site) return Promise.reject(new Error('Mod UI AbovePrompt site is unavailable'))
      return site.interact(drawing, callback, kind, element, value)
    }}
    chrome="band"
    onCollapse={toggle}
    onFocus={async (_pane, element, origin = { kind: 'person' }, options) => {
      if (element === undefined) {
        hold(false)
        return { focused: false }
      }
      const site = siteRef.current
      const plugin = options?.plugin ?? (origin.kind === 'plugin' ? origin.name : undefined)
      if (!site || !plugin || collapsedNow.current || hasSurvey) return { focused: false }
      if (origin.kind === 'person' && !heldNow.current) hold(true)
      return site.focus({ plugin, element, origin }, options)
    }}
    onScroll={async (_pane, by) => {
      setScrollOffset(current => Math.max(0, Math.min(maxOffset, current + by)))
    }}
    onReportMetrics={(_pane, metrics) => {
      setContentRows(metrics.contentRows)
    }}
    onError={onError}
  />{more}</Box>
}
