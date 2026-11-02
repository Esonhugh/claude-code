// Sources a turn read on the web (WebSearch, WebFetch, deep-research
// workflows), listed under the turn's answer and in exports.

import type { AgentTask } from './agents'
import { safeLinkHref } from './markdown/safeUrl'
import type { Block, Item } from './protocol'

export type Source = { url: string; title?: string }

const URL_IN_TEXT = /https?:\/\/[^\s"'`<>()[\]{}\\]+/g

function httpUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  const href = safeLinkHref(url.trim())
  return href && /^https?:\/\//i.test(href) ? href : undefined
}

function parseInput(input: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(input)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** WebSearch results carry `Links: [{"title":…,"url":…}]` lines. */
function searchLinks(result: string): Source[] {
  const sources: Source[] = []
  for (const match of result.matchAll(/^Links: (.*)$/gm)) {
    let links: unknown
    try {
      links = JSON.parse(match[1]!)
    } catch {
      continue
    }
    if (!Array.isArray(links)) continue
    for (const link of links) {
      if (typeof link !== 'object' || link === null) continue
      const { url, title } = link as { url?: unknown; title?: unknown }
      const href = httpUrl(url)
      if (href) sources.push({ url: href, ...(typeof title === 'string' && title && { title }) })
    }
  }
  return sources
}

function urlsIn(text: string): Source[] {
  return [...text.matchAll(URL_IN_TEXT)]
    .map(m => httpUrl(m[0].replace(/[.,;:!?]+$/, '')))
    .filter((url): url is string => !!url)
    .map(url => ({ url }))
}

export function toolSources(
  block: Extract<Block, { kind: 'tool' }>,
  task?: AgentTask,
): Source[] {
  if (block.isError) return []
  if (block.name === 'WebSearch') return searchLinks(block.result ?? '')
  if (block.name === 'WebFetch') {
    const url = httpUrl(parseInput(block.input).url)
    return url && block.result !== undefined ? [{ url }] : []
  }
  if (block.name === 'Workflow') {
    const name = parseInput(block.input).name
    const workflow = typeof name === 'string' ? name : (task?.workflowName ?? '')
    if (!/research/i.test(workflow)) return []
    return urlsIn(`${block.result ?? ''}\n${task?.summary ?? ''}`)
  }
  return []
}

/**
 * Sources of each turn (the items after one user message), keyed by the id of
 * the turn's last assistant message, deduplicated by URL.
 */
export function turnSources(
  items: Item[],
  tasksByToolUse?: Map<string, AgentTask>,
): Map<string, Source[]> {
  const out = new Map<string, Source[]>()
  let byUrl = new Map<string, Source>()
  let lastAssistant: string | undefined
  const flush = () => {
    if (lastAssistant && byUrl.size) out.set(lastAssistant, [...byUrl.values()])
    byUrl = new Map()
    lastAssistant = undefined
  }
  for (const item of items) {
    if (item.kind === 'user') {
      flush()
      continue
    }
    if (item.kind !== 'assistant') continue
    lastAssistant = item.id
    for (const block of item.blocks) {
      if (block?.kind !== 'tool') continue
      for (const source of toolSources(block, tasksByToolUse?.get(block.id))) {
        const seen = byUrl.get(source.url)
        if (!seen || (!seen.title && source.title)) byUrl.set(source.url, source)
      }
    }
  }
  flush()
  return out
}
