/**
 * Portal for content that floats above the prompt so it escapes
 * FullscreenLayout's bottom-slot `overflowY:hidden` clip.
 *
 * The clip is load-bearing (CC-668: tall pastes squash the ScrollBox
 * without it), but floating overlays use `position:absolute
 * bottom="100%"` to float above the prompt — and Ink's clip stack
 * intersects ALL descendants, so they were clipped to ~1 row.
 *
 * Two channels:
 * - `useSetPromptOverlay` — slash-command suggestion data (structured,
 *   written by PromptInputFooter)
 * - `useSetPromptOverlayDialog` — arbitrary dialog node (e.g.
 *   AutoModeOptInDialog, written by PromptInput)
 *
 * FullscreenLayout reads both and renders them outside the clipped slot.
 *
 * Split into data/setter context pairs so writers never re-render on
 * their own writes — the setter contexts are stable.
 */
import React, {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { subscribeLayout, type DOMElement } from '../ink/dom.js'
import { LayoutEdge } from '../ink/layout/node.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'

export type PromptOverlayData = {
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  maxColumnWidth?: number
}

type Setter<T> = (d: T | null) => void

const DataContext = createContext<PromptOverlayData | null>(null)
const SetContext = createContext<Setter<PromptOverlayData> | null>(null)
const DialogContext = createContext<ReactNode>(null)
const SetDialogContext = createContext<Setter<ReactNode> | null>(null)
export const PromptDockColumnsContext = createContext(0)
const LayoutContext = createContext<{
  anchor: RefObject<DOMElement | null>
  container?: RefObject<DOMElement | null>
} | null>(null)

export function PromptOverlayProvider({
  children,
  container,
}: {
  children: ReactNode
  container?: RefObject<DOMElement | null>
}): ReactNode {
  const anchor = useRef<DOMElement>(null)
  const layout = useMemo(() => ({ anchor, container }), [container])
  const [data, setData] = useState<PromptOverlayData | null>(null)
  const [dialog, setDialog] = useState<ReactNode>(null)
  return (
    <LayoutContext value={layout}>
      <SetContext.Provider value={setData}>
        <SetDialogContext.Provider value={setDialog}>
          <DataContext.Provider value={data}>
            <DialogContext.Provider value={dialog}>
              {children}
            </DialogContext.Provider>
          </DataContext.Provider>
        </SetDialogContext.Provider>
      </SetContext.Provider>
    </LayoutContext>
  )
}

export function usePromptOverlayAnchor():
  | RefObject<DOMElement | null>
  | undefined {
  return useContext(LayoutContext)?.anchor
}

/** Only the prompt's own leading margin may extend the dock into the bottom slot. */
export function usePromptOverlayGap(): number {
  const layout = useContext(LayoutContext)
  const subscribe = useCallback(
    (listener: () => void) => {
      const container = layout?.container?.current
      if (!container) return () => {}
      let active = true
      let pending = false
      const unsubscribe = subscribeLayout(container, () => {
        if (pending) return
        pending = true
        queueMicrotask(() => {
          pending = false
          if (active) listener()
        })
      })
      return () => {
        active = false
        unsubscribe()
      }
    },
    [layout],
  )
  return useSyncExternalStore(subscribe, () => {
    const container = layout?.container?.current
    const anchor = layout?.anchor.current
    if (!container || !anchor?.yogaNode) return 0
    let top = 0
    let node: DOMElement | undefined = anchor
    while (node && node !== container) {
      top += node.yogaNode?.getComputedTop() ?? 0
      node = node.parentNode
    }
    if (node !== container) return 0
    const margin = anchor.yogaNode.getComputedMargin(LayoutEdge.Top)
    return top === margin ? Math.max(0, margin) : 0
  })
}

export function usePromptOverlay(): PromptOverlayData | null {
  return useContext(DataContext)
}

export function usePromptOverlayDialog(): ReactNode {
  return useContext(DialogContext)
}

/**
 * Register suggestion data for the floating overlay. Clears on unmount.
 * No-op outside the provider (non-fullscreen renders inline instead).
 */
export function useSetPromptOverlay(data: PromptOverlayData | null): void {
  const set = useContext(SetContext)
  useEffect(() => {
    if (!set) return
    set(data)
    return () => set(null)
  }, [set, data])
}

/**
 * Register a dialog node to float above the prompt. Clears on unmount.
 * No-op outside the provider (non-fullscreen renders inline instead).
 */
export function useSetPromptOverlayDialog(node: ReactNode): void {
  const set = useContext(SetDialogContext)
  useEffect(() => {
    if (!set) return
    set(node)
    return () => set(null)
  }, [set, node])
}
