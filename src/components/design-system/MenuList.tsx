/**
 * MenuList is a keyboard-navigable list (Select context: up/down/enter) with
 * an optional icon per row, an aligned meta column, an optional description
 * line, and non-selectable section headings. It does not wrap around.
 */
import figures from 'figures'
import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { Theme } from '../../utils/theme.js'
import { ListItem } from './ListItem.js'

export type MenuListRow =
  | { kind: 'heading'; key: string; content?: React.ReactNode }
  | {
      kind: 'item'
      key: string
      icon?: string
      /** Colors the icon; without it the icon is dim. */
      iconColor?: keyof Theme
      label: string
      meta?: string[]
      description?: string
    }

type Props = {
  rows: MenuListRow[]
  onSelect: (itemIndex: number) => void
  defaultFocusIndex?: number
  onFocus?: (itemIndex: number) => void
  visibleItemCount?: number
}

export function MenuList({
  rows,
  onSelect,
  defaultFocusIndex = 0,
  onFocus,
  visibleItemCount = 12,
}: Props): React.ReactNode {
  const items = rows.flatMap((row, rowIndex) =>
    row.kind === 'item' ? [{ row, rowIndex }] : [],
  )
  const [focusIndex, setFocusIndex] = useState(() =>
    Math.min(defaultFocusIndex, Math.max(items.length - 1, 0)),
  )

  const moveFocus = (next: number) => {
    if (next < 0 || next >= items.length) return
    setFocusIndex(next)
    onFocus?.(next)
  }

  useKeybindings(
    {
      'select:next': () => moveFocus(focusIndex + 1),
      'select:previous': () => moveFocus(focusIndex - 1),
      'select:accept': () => {
        if (items[focusIndex]) onSelect(focusIndex)
      },
    },
    { context: 'Select' },
  )

  // The meta column lines up after the widest label that has meta.
  const labelWidth = Math.max(
    0,
    ...items
      .filter(({ row }) => row.meta?.some(Boolean))
      .map(({ row }) =>
        stringWidth(row.icon ? `${row.icon} ${row.label}` : row.label),
      ),
  )

  const firstVisible = Math.min(
    Math.max(0, focusIndex - visibleItemCount + 1),
    Math.max(0, items.length - visibleItemCount),
  )
  const lastVisible = firstVisible + visibleItemCount - 1
  const startRow = items[firstVisible]?.rowIndex ?? 0
  // Headings above the first visible item stay with it.
  let fromRow = startRow
  while (fromRow > 0 && rows[fromRow - 1]?.kind === 'heading') fromRow--
  const endRow = items[Math.min(lastVisible, items.length - 1)]?.rowIndex
  const toRow =
    lastVisible >= items.length - 1 ? rows.length - 1 : (endRow ?? 0)
  const hiddenAbove = firstVisible
  const hiddenBelow = Math.max(0, items.length - 1 - lastVisible)

  let itemIndex = items.findIndex(({ rowIndex }) => rowIndex >= fromRow)

  return (
    <Box flexDirection="column">
      {hiddenAbove > 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>
            {figures.arrowUp} {hiddenAbove} more
          </Text>
        </Box>
      )}
      {rows.slice(fromRow, toRow + 1).map(row => {
        if (row.kind === 'heading') {
          return (
            <Box key={row.key} paddingLeft={2}>
              <Text wrap="truncate-end">{row.content ?? ' '}</Text>
            </Box>
          )
        }
        const index = itemIndex++
        const isFocused = index === focusIndex
        const meta = (row.meta ?? []).filter(Boolean).join(' · ')
        return (
          <ListItem
            key={row.key}
            isFocused={isFocused}
            description={row.description}
            styled={false}
          >
            <Box flexDirection="row">
              <Box width={meta ? labelWidth + 3 : undefined}>
                <Text
                  color={isFocused ? 'suggestion' : undefined}
                  wrap="truncate-end"
                >
                  {row.icon && (
                    <Text
                      color={row.iconColor}
                      dimColor={row.iconColor === undefined}
                    >
                      {row.icon}{' '}
                    </Text>
                  )}
                  {row.label}
                </Text>
              </Box>
              {meta && <Text dimColor>{meta}</Text>}
            </Box>
          </ListItem>
        )
      })}
      {hiddenBelow > 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>
            {figures.arrowDown} {hiddenBelow} more
          </Text>
        </Box>
      )}
    </Box>
  )
}
