import type { DOMElement } from './dom.js'
import { readPaintedScrollTop } from './dom.js'
import { getFocusManager } from './focus.js'
import { nodeCache } from './node-cache.js'

type Control = { plugin: string; key: string; element: DOMElement; emptyButton: boolean }
type PaneCommit = Readonly<{
  plugin: string; id: string; activation: number; lease: number; revision: number;
  drawing?: number; visible: boolean; shown: boolean; placement: 'dock' | 'inline';
  focused: boolean; focusedElement?: string; focusedPlugin?: string
}>
type Geometry = { viewport: DOMElement | undefined; controls: readonly Control[] }
export type TerminalPaneCommit = { pane: PaneCommit; geometry(): Geometry }
export type TerminalPaneEvidence = PaneCommit & {
  mount: number
  paintable: boolean
  rect: { x: number; y: number; width: number; height: number } | null
  bodyRect: { x: number; y: number; width: number; height: number } | null
  paintedScrollTop: number | null
  actualFocusWithin: boolean
  actualFocusedElement?: string
  actualFocusedPlugin?: string
  controls: readonly { plugin: string; key: string; rect: TerminalPaneEvidence['rect']; paintable: boolean; emptyButton: boolean }[]
}

const commits = new WeakMap<DOMElement, TerminalPaneCommit>()
const uiRevisions = new WeakMap<DOMElement, number>()
const mounts = new WeakMap<DOMElement, number>()
let nextMount = 1
export function setTerminalUiRevision(node: DOMElement, value: number | undefined): void {
  if (value === undefined) uiRevisions.delete(node)
  else uiRevisions.set(node, value)
}
export function collectTerminalUiRevision(root: DOMElement): number | undefined {
  if (!process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH) return undefined
  const revisions: number[] = []
  const visit = (node: DOMElement) => {
    if (!visibleIn(node, root)) return
    const revision = uiRevisions.get(node)
    if (revision !== undefined && rectOf(node)) revisions.push(revision)
    for (const child of node.childNodes) if (child.nodeName !== '#text') visit(child)
  }
  visit(root)
  return revisions.length === 1 ? revisions[0] : undefined
}
export function setTerminalPaneCommit(node: DOMElement, value: TerminalPaneCommit | undefined): void {
  if (!value) { commits.delete(node); return }
  if (!mounts.has(node)) mounts.set(node, nextMount++)
  commits.set(node, { pane: Object.freeze({ ...value.pane }), geometry: value.geometry })
}

function visibleIn(node: DOMElement, root: DOMElement): boolean {
  let current: DOMElement | undefined = node
  while (current) {
    if (current.isHidden || current.style.display === 'none') return false
    if (current === root) return true
    current = current.parentNode
  }
  return false
}
function rectOf(node: DOMElement | undefined): NonNullable<TerminalPaneEvidence['rect']> | undefined {
  const rect = node && nodeCache.get(node)
  if (!rect || rect.width <= 0 || rect.height <= 0) return undefined
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

/** Read only committed registrations and geometry painted by this renderer. */
export function collectTerminalPaneEvidence(root: DOMElement): readonly TerminalPaneEvidence[] | undefined {
  if (!process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH) return undefined
  const result: TerminalPaneEvidence[] = []
  const nodes: DOMElement[] = []
  const visit = (node: DOMElement) => {
    if (commits.has(node)) nodes.push(node)
    for (const child of node.childNodes) if (child.nodeName !== '#text') visit(child)
  }
  visit(root)
  const scrollViewport = (node: DOMElement): DOMElement | undefined => {
    if (node.style.overflowY === 'scroll') return node
    for (const child of node.childNodes) {
      if (child.nodeName === '#text' || commits.has(child)) continue
      const found = scrollViewport(child)
      if (found) return found
    }
    return undefined
  }
  for (const node of nodes) {
    const entry = commits.get(node)!, pane = entry.pane
    const visible = pane.visible && pane.shown && visibleIn(node, root)
    const rect = visible ? rectOf(node) : undefined, geometry = entry.geometry()
    const viewport = geometry.viewport && visibleIn(geometry.viewport, node)
      ? geometry.viewport : scrollViewport(node)
    const bodyRect = visible ? rectOf(viewport) : undefined
    const controls = geometry.controls.filter(control => visible && visibleIn(control.element, node))
    const active = getFocusManager(node).activeElement
    let current: DOMElement | null | undefined = active
    let landing: Control | undefined
    while (current && current !== node) {
      landing ??= controls.find(control => control.element === current)
      current = current.parentNode
    }
    result.push({ ...pane, mount: mounts.get(node)!, paintable: Boolean(rect && bodyRect),
      rect: rect ?? null, bodyRect: bodyRect ?? null,
      paintedScrollTop: visible && viewport ? readPaintedScrollTop(viewport) ?? null : null,
      actualFocusWithin: current === node,
      ...(landing ? { actualFocusedElement: landing.key, actualFocusedPlugin: landing.plugin } : {}),
      controls: controls.map(control => {
        const rect = rectOf(control.element)
        return { plugin: control.plugin, key: control.key, rect: rect ?? null,
          paintable: Boolean(rect), emptyButton: control.emptyButton }
      }),
    })
  }
  return result
}
