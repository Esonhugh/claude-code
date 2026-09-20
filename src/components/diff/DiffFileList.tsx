import React from 'react'
import type { DiffFile } from '../../hooks/useDiffData.js'
import { Box, Text } from '../../ink.js'
import type { DOMElement } from '../../ink/dom.js'
import { diffDisplayText } from './displayText.js'

type Props = {
  files: DiffFile[]
  selectedIndex: number
  onSelect?: (path: string) => void
  rowRef?: (path: string, element: DOMElement | null) => void
}

// The parent owns the bounded ScrollBox; selecting a row never replaces it.
export function DiffFileList({
  files,
  selectedIndex,
  onSelect,
  rowRef,
}: Props): React.ReactNode {
  if (files.length === 0) return <Text dimColor>No changed files</Text>
  return (
    <Box flexDirection="column" flexShrink={0}>
      {files.map((file, index) => (
        <Box
          key={file.path}
          ref={element => rowRef?.(file.path, element)}
          flexShrink={0}
          height={1}
          onClick={() => onSelect?.(file.path)}
        >
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text
              bold={index === selectedIndex}
              color={index === selectedIndex ? 'suggestion' : undefined}
              wrap="truncate-middle"
            >
              {index === selectedIndex ? '› ' : '  '}
              {diffDisplayText(file.path)}
            </Text>
          </Box>
          {file.isBinary ? (
            <Text dimColor> binary</Text>
          ) : (
            <Text>
              <Text color="diffAdded"> +{file.linesAdded}</Text>
              <Text color="diffRemoved"> -{file.linesRemoved}</Text>
              {file.isUntracked && <Text dimColor> new</Text>}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  )
}
