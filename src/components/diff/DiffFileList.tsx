import React from 'react'
import type { DiffFile } from '../../hooks/useDiffData.js'
import { Box, Text } from '../../ink.js'
import type { DOMElement } from '../../ink/dom.js'
import { diffDisplayText } from './displayText.js'

type Props = {
  files: DiffFile[]
  selectedIndex: number
  showSelection?: boolean
  onSelect?: (path: string) => void
  rowRef?: (path: string, element: DOMElement | null) => void
}

export function DiffStat({
  added,
  removed,
}: {
  added: number
  removed: number
}): React.ReactNode {
  return (
    <Text>
      {added > 0 && <Text color="diffAdded">+{added}</Text>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <Text color="diffRemoved">-{removed}</Text>}
    </Text>
  )
}

// The parent owns the bounded ScrollBox; selecting a row never replaces it.
export function DiffFileList({
  files,
  selectedIndex,
  showSelection = false,
  onSelect,
  rowRef,
}: Props): React.ReactNode {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {files.map((file, index) => {
        const selected = showSelection && index === selectedIndex
        return (
          <Box
            key={file.path}
            ref={element => rowRef?.(file.path, element)}
            flexShrink={0}
            height={1}
            onClick={() => onSelect?.(file.path)}
          >
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text
                bold={selected}
                color={selected ? 'suggestion' : undefined}
                dimColor={!selected}
                wrap="truncate-start"
              >
                {showSelection && (selected ? '› ' : '  ')}
                {diffDisplayText(file.path)}
              </Text>
            </Box>
            {file.isBinary ? (
              <Text dimColor> binary</Text>
            ) : (
              !file.isUntracked &&
              (file.linesAdded > 0 || file.linesRemoved > 0) && (
                <Box flexShrink={0} marginLeft={1}>
                  <DiffStat
                    added={file.linesAdded}
                    removed={file.linesRemoved}
                  />
                </Box>
              )
            )}
          </Box>
        )
      })}
    </Box>
  )
}
