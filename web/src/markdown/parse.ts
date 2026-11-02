import type { Root } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'

export function parseMarkdown(text: string): Root {
  return fromMarkdown(text, {
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
