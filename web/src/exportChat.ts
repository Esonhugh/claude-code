// Builds a Markdown copy of a conversation for download.

import { modelLabel } from './components/Message'
import type { Item } from './protocol'
import type { Source } from './sources'
import { toolSummary } from './tools'

function oneLine(text: string, max = 120): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function sourceMarkdown(source: Source): string {
  const url = source.url.replace(/[()<> ]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const title = (source.title ?? new URL(source.url).hostname).replace(/[[\]\\]/g, '\\$&')
  return `[${oneLine(title)}](${url})`
}

export function chatMarkdown(
  title: string,
  items: Item[],
  sources: Map<string, Source[]>,
  labels: { you: string; sources: string },
  fallbackModel?: string,
): string {
  const parts = [`# ${oneLine(title)}`]
  let previous: Item['kind'] | undefined
  for (const item of items) {
    if (item.kind === 'user') {
      parts.push(`## ${labels.you}`, item.text)
    } else if (item.kind === 'error' || item.kind === 'local' || item.kind === 'recap' || item.kind === 'note') {
      parts.push(`> ${oneLine(item.text, 500)}`)
    } else if (item.kind === 'peer') {
      parts.push(`## ← ${oneLine(item.from)}`, item.text)
    } else if (item.kind === 'compact' || item.kind === 'goal' || item.kind === 'event') {
      continue
    } else if (item.kind === 'teammate') {
      parts.push(`## @${oneLine(item.from)}`, item.text)
    } else if (item.kind === 'channel') {
      parts.push(`## ← ${oneLine(item.source)}${item.user ? ` · ${oneLine(item.user)}` : ''}`, item.text)
    } else {
      if (previous !== 'assistant') {
        const label = modelLabel(item.model ?? fallbackModel)
        parts.push(`## ${label ? `Claude (${label})` : 'Claude'}`)
      }
      const tools: string[] = []
      const flushTools = () => {
        if (tools.length) parts.push(tools.splice(0).join('\n'))
      }
      for (const block of item.blocks) {
        if (block?.kind === 'text' && block.text.trim()) {
          flushTools()
          parts.push(block.text.trim())
        } else if (block?.kind === 'tool') {
          const summary = oneLine(toolSummary(block.name, block.input))
          tools.push(`- \`${block.name}\`${summary ? ` ${summary.replace(/`/g, "'")}` : ''}`)
        }
      }
      flushTools()
      const list = sources.get(item.id)
      if (list?.length) {
        parts.push(
          `**${labels.sources}**`,
          list.map((s, i) => `${i + 1}. ${sourceMarkdown(s)}`).join('\n'),
        )
      }
    }
    previous = item.kind
  }
  return `${parts.join('\n\n')}\n`
}

/** A file name from a chat title, without characters file systems reject. */
export function exportFileName(title: string, ext: string): string {
  const base = [...title]
    .map(c => (c < ' ' || '\\/:*?"<>|'.includes(c) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${base || 'claude-chat'}.${ext}`
}
