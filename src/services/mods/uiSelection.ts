import type Ink from '../../ink/ink.js'
import type { SelectionState } from '../../ink/selection.js'
import type { DOMElement } from '../../ink/dom.js'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'

export type ModUiSelection = { text: string; requestId?: string }

export function readModUiSelection(
  source: Pick<Ink, 'isAltScreenActive' | 'hasTextSelection' | 'getSelectedText' | 'selection'> | undefined,
  rowHolding?: (selection: SelectionState) => string | undefined,
): ModUiSelection | undefined {
  if (!source?.isAltScreenActive || !source.hasTextSelection()) return undefined
  const text = source.getSelectedText()
  if (text === '') return undefined
  const requestId = rowHolding?.(source.selection)
  return requestId ? {text,requestId} : {text}
}

export function findModSelectionRow(
  selection: SelectionState,
  viewport: Pick<ScrollBoxHandle, 'getElement' | 'getViewportTop' | 'getViewportHeight'>,
  rows: () => readonly {requestId:string;node:DOMElement}[],
): string | undefined {
  if (!selection.anchor || !selection.focus || !viewport.getElement() || selection.scope?.node !== viewport.getElement()) return undefined
  const top = viewport.getViewportTop(), bottom = top + viewport.getViewportHeight() - 1
  if ((selection.virtualAnchorRow === undefined && (selection.anchor.row < top || selection.anchor.row > bottom)) ||
      (selection.virtualFocusRow === undefined && (selection.focus.row < top || selection.focus.row > bottom))) return undefined
  const first = Math.min(selection.virtualAnchorRow ?? selection.anchor.row, selection.virtualFocusRow ?? selection.focus.row)
  const last = Math.max(selection.virtualAnchorRow ?? selection.anchor.row, selection.virtualFocusRow ?? selection.focus.row)
  for (const {requestId,node} of rows()) {
    const height = node.yogaNode?.getComputedHeight() ?? 0
    if (height < 1) continue
    let row = 0, current: DOMElement | undefined = node
    while (current) {
      if (!current.yogaNode) break
      row += current.yogaNode.getComputedTop() - (current !== node && (current.style.overflowY ?? current.style.overflow) === 'scroll' ? current.scrollTopRendered ?? 0 : 0)
      current = current.parentNode
    }
    if (!current && row <= first && last <= row + height - 1) return requestId
  }
  return undefined
}

type SelectionSource = Pick<Ink, 'isAltScreenActive' | 'hasTextSelection' | 'getSelectedText' | 'selection' | 'subscribeToSelectionTakeDown' | 'subscribeToSelectionChange'>
export function createModUiSelectionTracker(
  source: () => SelectionSource | undefined,
  rowHolding: (selection: SelectionState) => string | undefined,
) {
  let kept: ModUiSelection | undefined, runs = 0, takenAfter = 0
  return {
    read(): ModUiSelection | undefined {
      const ink = source()
      return ink?.isAltScreenActive ? readModUiSelection(ink, rowHolding) ?? kept : undefined
    },
    beginRun(): number { return ++runs },
    endRun(run: number): void { if (run > takenAfter) kept = undefined },
    connect(): () => void {
      kept = undefined
      const ink = source()
      if (!ink) return () => {}
      const takeDown = ink.subscribeToSelectionTakeDown(() => {
        const value = readModUiSelection(ink,rowHolding)
        if (value) {kept=value;takenAfter=runs}
      })
      const change = ink.subscribeToSelectionChange(() => {
        if (kept && ink.hasTextSelection() && ink.getSelectedText() !== '') kept=undefined
      })
      return () => {takeDown();change();kept=undefined}
    },
  }
}
