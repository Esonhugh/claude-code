import stripAnsi from 'strip-ansi'
import type { DOMElement } from './dom.js'
import squashTextNodes from './squash-text-nodes.js'
import { wrapAnsi } from './wrapAnsi.js'

// Screen-reader mode renders the tree as flat text: no borders, colors or
// layout, one line per block. Set once at startup, before the first render.
let enabled = false

export function setScreenReaderEnabled(value: boolean): void {
  enabled = value
}

export function isScreenReaderEnabled(): boolean {
  return enabled
}

/** Flattens the tree: column boxes join their children with newlines, row boxes with spaces. */
export function renderNodeToScreenReaderOutput(node: DOMElement): string {
  if (node.style.display === 'none') return ''
  switch (node.nodeName) {
    case 'ink-text':
    case 'ink-virtual-text':
    case 'ink-link':
      return squashTextNodes(node)
    case 'ink-raw-ansi':
      return stripAnsi(String(node.attributes['rawText'] ?? ''))
    case 'ink-box':
    case 'ink-root': {
      const direction = node.style.flexDirection
      const row = direction === 'row' || direction === 'row-reverse'
      const children = direction?.endsWith('-reverse')
        ? [...node.childNodes].reverse()
        : node.childNodes
      const parts: string[] = []
      for (const child of children) {
        if (child.nodeName === '#text') continue
        const text = renderNodeToScreenReaderOutput(child)
        if (text.trim() !== '') parts.push(text)
      }
      return parts.join(row ? ' ' : '\n')
    }
    default:
      return ''
  }
}

/** The flat text as terminal rows: trailing spaces dropped, long lines hard-wrapped. */
export function screenReaderLines(node: DOMElement, width: number): string[] {
  const text = renderNodeToScreenReaderOutput(node)
  if (text === '') return []
  const lines: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\s+$/, '')
    if (trimmed === '') continue
    lines.push(...wrapAnsi(trimmed, Math.max(1, width), { hard: true, trim: false }).split('\n'))
  }
  return lines
}
