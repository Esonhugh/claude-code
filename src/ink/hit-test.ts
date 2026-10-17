import type { DOMElement } from './dom.js'
import { ClickEvent, type ClickDisposition } from './events/click-event.js'
import type { EventHandlerProps } from './events/event-handlers.js'
import { nodeCache } from './node-cache.js'
import { isEmptyCellAt, type Screen } from './screen.js'

/**
 * Find the deepest DOM element whose rendered rect contains (col, row).
 *
 * Uses the nodeCache populated by renderNodeToOutput — rects are in screen
 * coordinates with all offsets (including scrollTop translation) already
 * applied. Children are traversed in reverse so later siblings (painted on
 * top) win. Nodes not in nodeCache (not rendered this frame, or lacking a
 * yogaNode) are skipped along with their subtrees.
 *
 * Returns the hit node even if it has no onClick — dispatchClick walks up
 * via parentNode to find handlers.
 */
export function hitTest(
  node: DOMElement,
  col: number,
  row: number,
  depth = 0,
): DOMElement | null {
  if (depth >= 256) return null
  const rect = nodeCache.get(node)
  if (!rect) return null
  const inside = col >= rect.x && col < rect.x + rect.width &&
    row >= rect.y && row < rect.y + rect.height
  if (!inside && !node.hasAbsoluteDescendant) return null
  if (!inside) {
    const overflowX = node.style.overflowX ?? node.style.overflow
    const overflowY = node.style.overflowY ?? node.style.overflow
    if (((overflowX === 'hidden' || overflowX === 'scroll') && (col < rect.x || col >= rect.x + rect.width)) ||
        ((overflowY === 'hidden' || overflowY === 'scroll') && (row < rect.y || row >= rect.y + rect.height))) return null
  }
  let candidate: DOMElement | null = null
  let escaped = false
  // Absolute overflow is painted above in-flow siblings, even when its parent is earlier.
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const child = node.childNodes[i]!
    if (child.nodeName === '#text') continue
    const childRect = nodeCache.get(child)
    if (!childRect) continue
    const childInside = col >= childRect.x && col < childRect.x + childRect.width &&
      row >= childRect.y && row < childRect.y + childRect.height
    if (!childInside && !child.hasAbsoluteDescendant) continue
    if (candidate && childInside) continue
    const hit = hitTest(child, col, row, depth + 1)
    if (!hit) continue
    if (!candidate || (!childInside && !escaped)) {
      candidate = hit
      escaped = !childInside
    }
    if (escaped) break
  }
  return candidate ?? (inside ? node : null)
}

/**
 * Hit-test the root at (col, row) and bubble a ClickEvent from the deepest
 * containing node up through parentNode. Only nodes with an onClick handler
 * fire. Stops when a handler calls stopImmediatePropagation(). Returns
 * true if at least one onClick handler fired.
 */
export function dispatchClick(
  root: DOMElement,
  col: number,
  row: number,
  cellIsBlank = false,
): boolean {
  return dispatchMouseClick(root, new ClickEvent(col, row, cellIsBlank)) !== 'unhandled'
}

export function dispatchMouseClick(root: DOMElement, event: ClickEvent): ClickDisposition {
  const { col, row } = event
  let target: DOMElement | undefined = hitTest(root, col, row) ?? undefined
  if (!target) return 'unhandled'

  // Click-to-focus: find the closest focusable ancestor and focus it.
  // root is always ink-root, which owns the FocusManager.
  if (root.focusManager && !event.isWindowActivation) {
    let focusTarget: DOMElement | undefined = target
    while (focusTarget) {
      if (typeof focusTarget.attributes['tabIndex'] === 'number') {
        root.focusManager.handleClickFocus(focusTarget)
        break
      }
      focusTarget = focusTarget.parentNode
    }
  }
  let handled = false
  while (target) {
    const handler = target._eventHandlers?.onClick as
      | ((event: ClickEvent) => void)
      | undefined
    if (handler) {
      const rect = nodeCache.get(target)
      if (rect) {
        event.localCol = col - rect.x
        event.localRow = row - rect.y
      }
      event.defaultAllowed = false
      handler(event)
      if (!event.defaultAllowed) handled = true
      if (event.didStopImmediatePropagation()) { handled = !event.defaultAllowed; break }
    }
    target = target.parentNode
  }
  if (event.droppedAsStray) return 'stray'
  if (handled && event.endsClickChain) return 'repeat'
  return handled ? 'handled' : 'unhandled'
}

export function hoverCellIsBlank(
  root: DOMElement,
  screen: Screen,
  col: number,
  row: number,
  target: DOMElement | null = hitTest(root, col, row),
): boolean {
  if (!isEmptyCellAt(screen, col, row)) return false
  const rect = target && ['ink-text', 'ink-raw-ansi'].includes(target.nodeName) ? nodeCache.get(target) : undefined
  if (!rect) return true
  let left: number | undefined, right: number | undefined
  for (let x = col - 1; x >= Math.floor(rect.x); x--) {
    if (!isEmptyCellAt(screen, x, row)) { left = x; break }
  }
  for (let x = col + 1; x < Math.ceil(rect.x + rect.width); x++) {
    if (!isEmptyCellAt(screen, x, row)) { right = x; break }
  }
  return !(left !== undefined && right !== undefined &&
    hitTest(root, left, row) === target && hitTest(root, right, row) === target)
}

function hoverEligible(node: DOMElement, cellIsBlank: boolean): boolean {
  const handlers = node._eventHandlers as EventHandlerProps | undefined
  return Boolean(handlers?.onMouseEnter || handlers?.onMouseLeave) &&
    !(cellIsBlank && node.attributes.hoverIgnoresBlankCells)
}

/**
 * Fire onMouseEnter/onMouseLeave as the pointer moves. Like DOM
 * mouseenter/mouseleave: does NOT bubble — moving between children does
 * not re-fire on the parent. Walks up from the hit node collecting every
 * ancestor with a hover handler; diffs against the previous hovered set;
 * fires leave on the nodes exited, enter on the nodes entered.
 *
 * Mutates `hovered` in place so the caller (App instance) can hold it
 * across calls. Clears the set when the hit is null (cursor moved into a
 * non-rendered gap or off the root rect).
 */
export function dispatchHover(
  root: DOMElement,
  col: number,
  row: number,
  hovered: Set<DOMElement>,
  screenOrBlank: Screen | boolean = false,
): void {
  const next = new Set<DOMElement>()
  let node: DOMElement | undefined = hitTest(root, col, row) ?? undefined
  const blank = typeof screenOrBlank === 'boolean' ? screenOrBlank : hoverCellIsBlank(root, screenOrBlank, col, row, node ?? null)
  while (node) {
    if (hoverEligible(node, blank)) next.add(node)
    node = node.parentNode
  }
  for (const old of hovered) {
    if (!next.has(old)) {
      hovered.delete(old)
      // Skip handlers on detached nodes (removed between mouse events)
      if (old.parentNode) {
        ;(old._eventHandlers as EventHandlerProps | undefined)?.onMouseLeave?.()
      }
    }
  }
  for (const n of next) {
    if (!hovered.has(n)) {
      hovered.add(n)
      ;(n._eventHandlers as EventHandlerProps | undefined)?.onMouseEnter?.()
    }
  }
}

/** Paint follows only opted-in nodes; ordinary hover still waits for pointer motion. */
export function followHover(
  root: DOMElement,
  col: number,
  row: number,
  hovered: Set<DOMElement>,
  screenOrBlank: Screen | boolean = false,
): boolean {
  const target = hitTest(root, col, row)
  const blank = typeof screenOrBlank === 'boolean' ? screenOrBlank : hoverCellIsBlank(root, screenOrBlank, col, row, target)
  let changed = false
  for (const old of hovered) {
    if (!old.attributes.hoverFollowsPaint) continue
    let ancestor: DOMElement | undefined = target ?? undefined
    const handlers = old._eventHandlers as EventHandlerProps | undefined
    if (!hoverEligible(old, blank)) ancestor = undefined
    while (ancestor && ancestor !== old) ancestor = ancestor.parentNode
    if (!ancestor) {
      hovered.delete(old)
      changed = true
      if (old.parentNode) handlers?.onMouseLeave?.()
    }
  }
  let node: DOMElement | undefined = target ?? undefined
  while (node) {
    const handlers = node._eventHandlers as EventHandlerProps | undefined
    if (node.attributes.hoverFollowsPaint && hoverEligible(node, blank) && !hovered.has(node)) {
      hovered.add(node)
      changed = true
      handlers?.onMouseEnter?.()
    }
    node = node.parentNode
  }
  return changed
}
