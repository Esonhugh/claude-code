import type { StructuredPatchHunk } from 'diff'
import React, { useMemo } from 'react'
import type { DiffFile } from '../../hooks/useDiffData.js'
import { useSettings } from '../../hooks/useSettings.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { StructuredDiff } from '../StructuredDiff.js'
import { expectColorDiff } from '../StructuredDiff/colorDiff.js'
import { diffDisplayText } from './displayText.js'

export type DiffRenderBudget = { chars: number; nodes: number }

// Highlighted patches render as a constant number of RawAnsi leaves; only the
// fallback renderer creates Yoga nodes per wrapped row and word-diff span.
const HIGHLIGHTED_PATCH_NODES = 4

export function useHighlightedDiff(): boolean {
  const settings = useSettings()
  return (
    expectColorDiff() !== null && !(settings.syntaxHighlightingDisabled ?? false)
  )
}

// Each patch is a separate leaf, capped at 10k chars before StructuredDiff.
export function limitDiffHunks(
  hunks: StructuredPatchHunk[],
  budget: DiffRenderBudget,
  width: number,
  highlighted: boolean,
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
      const maxLineNumber = Math.max(
        0,
        hunk.oldStart + hunk.oldLines - 1,
        hunk.newStart + hunk.newLines - 1,
      )
      const effectiveWidth = Math.max(
        1,
        width - String(maxLineNumber).length - 3,
      )
      let rows = 1
      if (highlighted) {
        let rowWidth = 0
        for (const char of line.slice(1)) {
          const charWidth = stringWidth(char)
          if (rowWidth > 0 && rowWidth + charWidth > effectiveWidth) {
            rows++
            rowWidth = 0
          }
          rowWidth += charWidth
        }
      }
      const rendered = highlighted ? rows * Math.max(1, width) : cost
      if (cost > 10_000 || rendered > budget.chars) {
        flush()
        return { hunks: result, truncated: true }
      }
      if (chars + cost > 10_000) flush()
      const nodes = highlighted
        ? lines.length
          ? 0
          : HIGHLIGHTED_PATCH_NODES
        : 12 +
          2 * line.split(/(\W)/u).length +
          8 * Math.ceil(cost / Math.max(1, width - 12))
      if (nodes > budget.nodes) {
        flush()
        return { hunks: result, truncated: true }
      }
      lines.push(line)
      chars += cost
      budget.chars -= rendered
      budget.nodes -= nodes
    }
    flush()
  }
  return { hunks: result, truncated: false }
}

const SAFE_PATHSPEC = /^[\p{L}\p{N}._/@+-]+$/u

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
  const highlighted = useHighlightedDiff()
  const limited = useMemo(
    () =>
      limitDiffHunks(
        hunks,
        { chars: 78_000, nodes: 1400 },
        contentWidth,
        highlighted,
      ),
    [hunks, contentWidth, highlighted],
  )
  const firstHunk = limited.hunks[0]
  const firstLine =
    firstHunk?.newStart === 1
      ? (firstHunk.lines.find(line => !line.startsWith('-'))?.slice(1) ??
        null)
      : null
  const notice =
    isUntracked && !hunks.length
      ? [
          'New file not yet staged.',
          SAFE_PATHSPEC.test(filePath)
            ? `Run \`git add :/${filePath}\` to see line counts.`
            : 'Stage it with git add to see line counts.',
        ].join('\n')
      : bodyState === 'loading'
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
              ? 'No textual diff (metadata-only, empty or not loaded)'
              : !hunks.length
                ? renderTruncated
                  ? null
                  : 'Diff body unavailable (no content returned)'
                : null
  const truncated = renderTruncated || limited.truncated
  const divider = (
    <Text dimColor wrap="truncate-end">
      {'─'.repeat(contentWidth)}
    </Text>
  )
  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      {divider}
      <Box flexShrink={0}>
        <Box flexShrink={1} minWidth={0}>
          <Text bold wrap="truncate-middle">
            {diffDisplayText(filePath)}
          </Text>
        </Box>
        {isUntracked && (
          <Box flexShrink={0}>
            <Text> (untracked)</Text>
          </Box>
        )}
        <Box flexGrow={1} />
        {onAsk && !notice && hunks.length > 0 && (
          <Box flexShrink={0} marginLeft={1} onClick={onAsk}>
            <Text color={armed ? 'suggestion' : undefined} dimColor={!armed}>
              {armed ? '[Cancel Ask]' : '[Ask]'}
            </Text>
          </Box>
        )}
      </Box>
      {divider}
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
