import { readPaintedScrollTop, type DOMElement } from '../../ink/dom.js'
import { LayoutDisplay, LayoutEdge } from '../../ink/layout/node.js'

export type ModOnScreen = Readonly<{ first: number; last: number; of: number }>

/** Relative rows of this drawing in its transcript viewport, using painted scroll state. */
export function getModOnScreen(node: DOMElement | null): ModOnScreen | null | undefined {
  if (!node?.yogaNode) return undefined
  if (node.yogaNode.getDisplay() === LayoutDisplay.None) return null
  let top = 0
  let current = node
  for (;;) {
    const parent = current.parentNode
    if (!parent?.yogaNode || !current.yogaNode) return undefined
    top += current.yogaNode.getComputedTop()
    const scroll = parent.parentNode
    if (scroll?.yogaNode && (scroll.style.overflowY ?? scroll.style.overflow) === 'scroll') {
      const height = node.yogaNode.getComputedHeight()
      const paintedTop = readPaintedScrollTop(scroll)
      if (paintedTop === undefined || !height) return undefined
      const borderTop = scroll.yogaNode.getComputedBorder(LayoutEdge.Top)
      const bottom = scroll.yogaNode.getComputedHeight() - scroll.yogaNode.getComputedBorder(LayoutEdge.Bottom)
      const insideTop = borderTop + scroll.yogaNode.getComputedPadding(LayoutEdge.Top)
      const insideBottom = bottom - scroll.yogaNode.getComputedPadding(LayoutEdge.Bottom)
      const rowTop = parent.yogaNode.getComputedTop() + top - paintedTop
      const itemTop = parent.yogaNode.getComputedTop() + current.yogaNode.getComputedTop() - paintedTop
      const itemHeight = current.yogaNode.getComputedHeight()
      const first = Math.max(rowTop, borderTop)
      const last = Math.min(rowTop + height, bottom)
      return itemTop + itemHeight <= insideTop || itemTop >= insideBottom || first >= last
        ? null : { first: first - rowTop, last: last - rowTop - 1, of: height }
    }
    current = parent
  }
}

export function sameModOnScreen(a: ModOnScreen | null | undefined, b: ModOnScreen | null | undefined): boolean {
  return a === b || !!a && !!b && a.first === b.first && a.last === b.last && a.of === b.of
}
