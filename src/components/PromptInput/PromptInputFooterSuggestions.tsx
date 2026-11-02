import figures from 'figures'
import * as React from 'react'
import { memo, type ReactNode } from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink.js'
import { truncatePathMiddle, truncateToWidth } from '../../utils/format.js'
import { truncateToWidthNoEllipsis } from '../../utils/truncate.js'
import type { Theme } from '../../utils/theme.js'

export type SuggestionItem = {
  id: string
  displayText: string
  tag?: string
  description?: string
  // The typed text, highlighted in the name and description.
  query?: string
  metadata?: unknown
  color?: keyof Theme
}

export type SuggestionType =
  | 'command'
  | 'file'
  | 'directory'
  | 'agent'
  | 'shell'
  | 'custom-title'
  | 'slack-channel'
  | 'none'

export const OVERLAY_MAX_ITEMS = 5

// Every row reserves a two-column gutter so the selected row can carry a pointer.
const POINTER_WIDTH = 2

/**
 * Get the icon for a suggestion based on its type
 * Icons: + for files, ◇ for MCP resources, * for agents
 */
function getIcon(itemId: string): string {
  if (itemId.startsWith('file-')) return '+'
  if (itemId.startsWith('mcp-resource-')) return '◇'
  if (itemId.startsWith('agent-')) return '*'
  if (itemId.startsWith('codex-app-')) return '◇'
  return '+'
}

/**
 * Check if an item is a unified suggestion type (file, mcp-resource, or agent)
 */
function isUnifiedSuggestion(itemId: string): boolean {
  return (
    itemId.startsWith('file-') ||
    itemId.startsWith('mcp-resource-') ||
    itemId.startsWith('agent-') ||
    itemId.startsWith('codex-app-')
  )
}

// Name column, pointer included, capped at 40% of the terminal.
function getNameColumnWidth(columns: number, maxColumnWidth: number): number {
  return Math.min(maxColumnWidth, Math.floor(columns * 0.4))
}

function getDescriptionWidth(
  item: SuggestionItem,
  columns: number,
  nameColumnWidth: number,
): number {
  const tagWidth = item.tag ? stringWidth(`[${item.tag}] `) : 0
  return Math.max(0, columns - nameColumnWidth - tagWidth - 4)
}

function flattenDescription(description: string | undefined): string {
  // Skill descriptions can contain newlines (e.g. /claude-api's "TRIGGER
  // when:" block); rows never break on them.
  return (description ?? '').replace(/\s+/g, ' ').trim()
}

function getRowHeight(
  item: SuggestionItem,
  columns: number,
  maxColumnWidth: number,
): number {
  if (isUnifiedSuggestion(item.id) || !item.description) return 1
  const width = getDescriptionWidth(
    item,
    columns,
    getNameColumnWidth(columns, maxColumnWidth),
  )
  if (width <= 0) return 1
  return stringWidth(flattenDescription(item.description)) > width ? 2 : 1
}

// Splits at the last space that fits, so the second row starts on a word.
function splitAtWidth(text: string, width: number): [string, string] {
  if (width <= 0 || stringWidth(text) <= width) return [text, '']
  const head = truncateToWidthNoEllipsis(text, width)
  const rest = text.slice(head.length)
  if (rest.startsWith(' ')) return [head, rest.trimStart()]
  const lastSpace = head.lastIndexOf(' ')
  if (lastSpace > 0) return [head.slice(0, lastSpace), text.slice(lastSpace + 1)]
  return [head, rest]
}

// Ranges of `text` that match `query`: one contiguous run when possible,
// otherwise (unless contiguousOnly) the query's characters in order.
function getMatchRanges(
  text: string,
  query: string,
  contiguousOnly: boolean,
): Array<[number, number]> {
  const lower = text.toLowerCase()
  // Only plain-width text: index math must not split a grapheme.
  if (lower.length !== text.length || /[^\u0020-\u02ff]/.test(text)) return []
  const start = lower.indexOf(query)
  if (start !== -1) return [[start, start + query.length]]
  if (contiguousOnly) return []
  const ranges: Array<[number, number]> = []
  let from = 0
  for (const char of query) {
    const index = lower.indexOf(char, from)
    if (index === -1) return []
    const last = ranges.at(-1)
    if (last && last[1] === index) last[1] = index + 1
    else ranges.push([index, index + 1])
    from = index + 1
  }
  return ranges
}

function HighlightedText({
  text,
  query,
  color,
  isSelected,
  contiguousOnly = false,
}: {
  text: string
  query?: string
  color?: keyof Theme
  isSelected: boolean
  contiguousOnly?: boolean
}): ReactNode {
  const ranges = query ? getMatchRanges(text, query, contiguousOnly) : []
  if (ranges.length === 0) {
    return (
      <Text color={color} dimColor={!isSelected}>
        {text}
      </Text>
    )
  }
  const parts: ReactNode[] = []
  let cursor = 0
  const push = (from: number, to: number, matched: boolean) => {
    if (from >= to) return
    parts.push(
      <Text
        key={from}
        color={color}
        dimColor={!matched && !isSelected}
        bold={matched}
      >
        {text.slice(from, to)}
      </Text>,
    )
  }
  for (const [from, to] of ranges) {
    push(cursor, from, false)
    push(from, to, true)
    cursor = to
  }
  push(cursor, text.length, false)
  return <>{parts}</>
}

const SuggestionItemRow = memo(function SuggestionItemRow({
  item,
  maxColumnWidth,
  isSelected,
  allowWrap,
}: {
  item: SuggestionItem
  maxColumnWidth?: number
  isSelected: boolean
  allowWrap: boolean
}): ReactNode {
  const columns = useTerminalSize().columns
  const isUnified = isUnifiedSuggestion(item.id)
  const pointer = isSelected ? `${figures.pointer} ` : '  '

  // For unified suggestions (file, mcp-resource, agent), use single-line layout with icon
  if (isUnified) {
    const icon = getIcon(item.id)
    const textColor: keyof Theme | undefined = isSelected
      ? 'suggestion'
      : undefined
    const dimColor = !isSelected

    const isFile = item.id.startsWith('file-')
    const isMcpResource = item.id.startsWith('mcp-resource-')

    // Calculate layout widths
    // Layout: "X " (2) + displayText + " – " (3) + description + padding (4)
    const iconWidth = 2 // icon + space (fixed)
    const paddingWidth = 4
    const separatorWidth = item.description ? 3 : 0 // ' – ' separator

    // For files, truncate middle of path to show both directory context and filename
    // For MCP resources, limit displayText to 30 chars (truncate from end)
    // For agents, no truncation
    let displayText: string
    if (isFile) {
      // Reserve space for description if present, otherwise use all available space
      const descReserve = item.description
        ? Math.min(20, stringWidth(item.description))
        : 0
      const maxPathLength =
        columns -
        POINTER_WIDTH -
        iconWidth -
        paddingWidth -
        separatorWidth -
        descReserve
      displayText = truncatePathMiddle(item.displayText, maxPathLength)
    } else if (isMcpResource) {
      const maxDisplayTextLength = 30
      displayText = truncateToWidth(item.displayText, maxDisplayTextLength)
    } else {
      displayText = item.displayText
    }

    const availableWidth =
      columns -
      POINTER_WIDTH -
      iconWidth -
      stringWidth(displayText) -
      separatorWidth -
      paddingWidth

    // Build the full line as a single string to prevent wrapping
    let lineContent: string
    if (item.description) {
      const maxDescLength = Math.max(0, availableWidth)
      const truncatedDesc = truncateToWidth(
        item.description.replace(/\s+/g, ' '),
        maxDescLength,
      )
      lineContent = `${pointer}${icon} ${displayText} – ${truncatedDesc}`
    } else {
      lineContent = `${pointer}${icon} ${displayText}`
    }

    return (
      <Text color={textColor} dimColor={dimColor} wrap="truncate">
        {lineContent}
      </Text>
    )
  }

  // For non-unified suggestions (commands, shell, etc.): name column, then a
  // description that may wrap onto one more row (official 2.1.311).
  const nameColumnWidth = getNameColumnWidth(
    columns,
    maxColumnWidth ?? stringWidth(item.displayText) + 5,
  )
  const textColor = item.color || (isSelected ? 'suggestion' : undefined)

  let displayText = item.displayText
  const maxNameWidth = nameColumnWidth - POINTER_WIDTH - 2
  if (stringWidth(displayText) > maxNameWidth) {
    displayText = truncateToWidth(displayText, maxNameWidth)
  }
  const namePadding = ' '.repeat(
    Math.max(0, nameColumnWidth - POINTER_WIDTH - stringWidth(displayText)),
  )

  const tagText = item.tag ? `[${item.tag}] ` : ''
  const descriptionWidth = getDescriptionWidth(item, columns, nameColumnWidth)
  const description = flattenDescription(item.description)
  const [firstLine, secondLine] = allowWrap
    ? splitAtWidth(description, descriptionWidth)
    : [truncateToWidth(description, descriptionWidth), '']
  const descriptionColor = isSelected ? 'suggestion' : undefined

  const firstRow = (
    <Text wrap="truncate">
      <Text color={textColor} dimColor={!isSelected}>
        {pointer}
      </Text>
      <HighlightedText
        text={displayText}
        query={item.query}
        color={textColor}
        isSelected={isSelected}
      />
      <Text color={textColor} dimColor={!isSelected}>
        {namePadding}
      </Text>
      {tagText ? <Text dimColor>{tagText}</Text> : null}
      <HighlightedText
        text={firstLine}
        query={item.query}
        color={descriptionColor}
        isSelected={isSelected}
        contiguousOnly
      />
    </Text>
  )
  if (!secondLine) return firstRow

  const indent = nameColumnWidth + stringWidth(tagText)
  return (
    <Box flexDirection="column">
      {firstRow}
      <Text wrap="truncate">
        {' '.repeat(indent)}
        <HighlightedText
          text={truncateToWidth(secondLine, Math.max(0, columns - indent - 4))}
          query={item.query}
          color={descriptionColor}
          isSelected={isSelected}
          contiguousOnly
        />
      </Text>
    </Box>
  )
})

type Props = {
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  maxColumnWidth?: number
  /**
   * When true, the suggestions are rendered inside a position=absolute
   * overlay. We omit minHeight and flex-end so the y-clamp in the
   * renderer doesn't push fewer items down into the prompt area.
   */
  overlay?: boolean
}

export function PromptInputFooterSuggestions({
  suggestions,
  selectedSuggestion,
  maxColumnWidth: maxColumnWidthProp,
  overlay,
}: Props): ReactNode {
  const { rows, columns } = useTerminalSize()
  // Maximum number of rows to show at once. Inline (under the prompt) uses
  // half the terminal, at least 6 rows, leaving 3 rows for the prompt, like
  // official 2.1.311. Overlay mode (fullscreen) uses a fixed 5 — the floating
  // box sits over the ScrollBox, so terminal height isn't the constraint.
  const maxRows = overlay
    ? OVERLAY_MAX_ITEMS
    : Math.max(1, Math.min(Math.max(6, Math.floor(rows / 2)), rows - 3))

  // No suggestions to display
  if (suggestions.length === 0) {
    return null
  }

  // Use prop if provided (stable width from all commands), otherwise calculate from visible
  const maxColumnWidth =
    maxColumnWidthProp ??
    Math.max(...suggestions.map(item => stringWidth(item.displayText))) + 5

  // Window around the selection, counting wrapped rows: up to half the rows
  // above the selection, then fill below, then back-fill above.
  const allowWrap = maxRows >= 2
  const selected = Math.max(0, Math.min(selectedSuggestion, suggestions.length - 1))
  const offset = Math.max(0, selected - maxRows)
  const candidates = suggestions.slice(offset, selected + maxRows + 1)
  const heights = candidates.map(item =>
    allowWrap ? getRowHeight(item, columns, maxColumnWidth) : 1,
  )
  const height = (index: number) => heights[index] ?? 1
  const selectedIndex = selected - offset
  let start = selectedIndex
  let end = selectedIndex + 1
  let usedRows = height(selectedIndex)
  let rowsAbove = 0
  while (
    start > 0 &&
    usedRows < maxRows &&
    rowsAbove + height(start - 1) <= Math.floor(maxRows / 2)
  ) {
    start--
    rowsAbove += height(start)
  }
  usedRows += rowsAbove
  while (end < candidates.length && usedRows + height(end) <= maxRows) {
    usedRows += height(end)
    end++
  }
  while (start > 0 && usedRows + height(start - 1) <= maxRows) {
    start--
    usedRows += height(start)
  }
  const visibleItems = candidates.slice(start, end)

  // In non-overlay (inline) mode, justifyContent keeps suggestions
  // anchored to the bottom (near the prompt). In overlay mode we omit
  // both minHeight and flex-end: the parent is position=absolute with
  // bottom='100%', so its y is clamped to 0 by the renderer when it
  // would go negative. Adding minHeight + flex-end would create empty
  // padding rows that shift the visible items down into the prompt area
  // when the list has fewer items than maxRows.
  return (
    <Box
      flexDirection="column"
      justifyContent={overlay ? undefined : 'flex-end'}
    >
      {visibleItems.map(item => (
        <SuggestionItemRow
          key={item.id}
          item={item}
          maxColumnWidth={maxColumnWidth}
          isSelected={item.id === suggestions[selectedSuggestion]?.id}
          allowWrap={allowWrap}
        />
      ))}
    </Box>
  )
}

export default memo(PromptInputFooterSuggestions)
