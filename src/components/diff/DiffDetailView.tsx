import type { StructuredPatchHunk } from 'diff'
import React, { useMemo } from 'react'
import type { DiffFile } from '../../hooks/useDiffData.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { StructuredDiff } from '../StructuredDiff.js'
import { diffDisplayText } from './displayText.js'

export type DiffRenderBudget = { chars: number; nodes: number }

// Budget the fallback renderer too: wrapping and word-level spans create nodes.
// Each patch is a separate Code leaf, capped before invoking StructuredDiff.
export function limitDiffHunks(
  hunks: StructuredPatchHunk[],
  budget: DiffRenderBudget,
  width: number,
): { hunks: StructuredPatchHunk[]; truncated: boolean } {
  const result: StructuredPatchHunk[] = []
  for (const hunk of hunks) {
    let oldStart = hunk.oldStart
    let newStart = hunk.newStart
    let lines: string[] = []
    let chars = 0
    const flush = () => {
      if (!lines.length) return
      const oldLines = lines.filter(line => !line.startsWith('+')).length
      const newLines = lines.filter(line => !line.startsWith('-')).length
      result.push({
        ...hunk,
        oldStart,
        newStart,
        oldLines,
        newLines,
        lines,
      })
      oldStart += oldLines
      newStart += newLines
      lines = []
      chars = 0
    }
    for (const rawLine of hunk.lines) {
      const line = diffDisplayText(rawLine)
      const cost = line.length + 1
      if (cost > 10_000 || cost > budget.chars) {
        flush()
        return { hunks: result, truncated: true }
      }
      const nodes =
        12 +
        2 * line.split(/(\W)/u).length +
        8 * Math.ceil(cost / Math.max(1, width - 12))
      if (nodes > budget.nodes) {
        flush()
        return { hunks: result, truncated: true }
      }
      if (chars + cost > 10_000) flush()
      lines.push(line)
      chars += cost
      budget.chars -= cost
      budget.nodes -= nodes
    }
    flush()
  }
  return { hunks: result, truncated: false }
}

type Props = {
  filePath: string
  hunks: StructuredPatchHunk[]
  isLargeFile?: boolean
  isBinary?: boolean
  isTruncated?: boolean
  isUntracked?: boolean
  bodyState?: DiffFile['bodyState']
  renderTruncated?: boolean
  width?: number
  armed?: boolean
  onAsk?: () => void
}

export function DiffDetailView({
  filePath,
  hunks,
  isLargeFile,
  isBinary,
  isTruncated,
  isUntracked,
  bodyState,
  renderTruncated,
  width,
  armed,
  onAsk,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const contentWidth = Math.max(1, width ?? columns - 4)
  const limited = useMemo(
    () =>
      limitDiffHunks(hunks, { chars: 78_000, nodes: 1400 }, contentWidth),
    [hunks, contentWidth],
  )
  const firstHunk = limited.hunks[0]
  const firstLine =
    firstHunk?.newStart === 1
      ? (firstHunk.lines.find(line => !line.startsWith('-'))?.slice(1) ??
        null)
      : null
  const notice =
    bodyState === 'loading'
      ? 'Loading diff body…'
      : bodyState === 'unavailable'
        ? hunks.length > 0
          ? 'Diff body unavailable · showing last good body'
          : 'Diff body unavailable'
        : isBinary || bodyState === 'binary'
          ? 'Binary file - cannot display diff'
          : isLargeFile || bodyState === 'large'
            ? 'Large file - diff exceeds display limit'
            : bodyState === 'no-body'
              ? isUntracked
                ? 'New file not yet staged; diff body not loaded'
                : 'No textual diff (metadata-only, empty or not loaded)'
              : !hunks.length
                ? renderTruncated
                  ? null
                  : 'Diff body unavailable (no content returned)'
                : null
  const truncated = renderTruncated || limited.truncated
  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box flexShrink={0}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text bold wrap="truncate-middle">
            {diffDisplayText(filePath)}
          </Text>
        </Box>
        {isUntracked && <Text dimColor> (untracked)</Text>}
        {onAsk && !notice && hunks.length > 0 && (
          <Box flexShrink={0} onClick={onAsk}>
            <Text color="suggestion">
              {' '}
              {armed ? '[Cancel Ask]' : '[Ask]'}
            </Text>
          </Box>
        )}
      </Box>
      {notice && <Text dimColor>{notice}</Text>}
      {(!notice || bodyState === 'unavailable') &&
        limited.hunks.map((patch, index) => (
          <StructuredDiff
            key={index}
            patch={patch}
            filePath={filePath}
            firstLine={firstLine}
            dim={false}
            width={contentWidth}
          />
        ))}
      {isTruncated && (
        <Text dimColor>… diff truncated (400 line read limit)</Text>
      )}
      {truncated && <Text dimColor>… diff truncated (render budget)</Text>}
    </Box>
  )
}
