import type { Root } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'

/**
 * Rewrites LaTeX `\[…\]` and `\(…\)` delimiters, which models often use,
 * to the `$$…$$` and `$…$` that the math extension parses. Code fences and
 * inline code are left alone.
 */
export function normalizeMathDelimiters(text: string): string {
  if (!text.includes('\\[') && !text.includes('\\(')) return text
  const rewrite = (prose: string) =>
    prose
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => `\n$$\n${tex.trim()}\n$$\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => `$${tex.trim()}$`)
  const out: string[] = []
  let prose: string[] = []
  let fence: string | null = null
  const flush = () => {
    if (!prose.length) return
    // Inline code spans keep their text; odd groups of the split are code.
    out.push(
      prose
        .join('\n')
        .split(/(`+[^`]*?`+)/)
        .map((part, i) => (i % 2 ? part : rewrite(part)))
        .join(''),
    )
    prose = []
  }
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence === null && marker) {
      flush()
      fence = marker
      out.push(line)
    } else if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      out.push(line)
    } else {
      prose.push(line)
    }
  }
  flush()
  return out.join('\n')
}

export function parseMarkdown(text: string): Root {
  return fromMarkdown(normalizeMathDelimiters(text), {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })
}

/**
 * Splits a streaming message into the settled prefix and the tail that may
 * still change, at the last blank line outside a code fence. Re-parsing only
 * the tail keeps long streamed replies cheap.
 */
export function splitSettled(text: string): { settled: string; tail: string } {
  let fence: string | null = null
  let cut = 0
  let offset = 0
  for (const line of text.split('\n')) {
    const next = offset + line.length + 1
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null
      }
    } else if (fence === null && line.trim() === '' && next <= text.length) {
      cut = next
    }
    offset = next
  }
  return { settled: text.slice(0, cut), tail: text.slice(cut) }
}
