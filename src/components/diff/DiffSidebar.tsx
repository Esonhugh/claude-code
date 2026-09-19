import { resolve } from 'node:path'
import React, { useEffect, useRef, useState } from 'react'
import { useDiffData, type DiffFile } from '../../hooks/useDiffData.js'
import { useTurnDiffs } from '../../hooks/useTurnDiffs.js'
import { Box, Text, useStdin } from '../../ink.js'
import ScrollBox, {
  type ScrollBoxHandle,
} from '../../ink/components/ScrollBox.js'
import type { DOMElement } from '../../ink/dom.js'
import type { InputEvent } from '../../ink/events/input-event.js'
import { getRootNode } from '../../ink/focus.js'
import { hitTest } from '../../ink/hit-test.js'
import type { Message } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import { findGitRoot } from '../../utils/git.js'
import { DiffDetailView } from './DiffDetailView.js'

type Props = {
  messages: Message[]
  onClose: () => void
}

export function DiffSidebar({ messages, onClose }: Props): React.ReactNode {
  const data = useDiffData(2000)
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const { internal_eventEmitter } = useStdin()
  useEffect(() => {
    // Consume sidebar wheel events before the transcript's global listener.
    const capture = (event: InputEvent) => {
      const pointer = event.keypress.pointer
      const viewport = scrollRef.current?.getElement()
      if (!pointer || !viewport || !(event.key.wheelUp || event.key.wheelDown))
        return
      let hit: DOMElement | undefined =
        hitTest(getRootNode(viewport), pointer.column, pointer.row) ?? undefined
      while (hit && hit !== viewport) hit = hit.parentNode
      if (!hit) return
      event.stopImmediatePropagation()
      scrollRef.current?.scrollBy(event.key.wheelUp ? -3 : 3)
    }
    internal_eventEmitter?.prependListener('input', capture)
    return () => {
      internal_eventEmitter?.removeListener('input', capture)
    }
  }, [internal_eventEmitter])
  const turns = useTurnDiffs(messages)
  const [showOther, setShowOther] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const editedPaths = new Set(
    turns.flatMap((turn) =>
      [...turn.files.keys()].map((path) => resolve(getCwd(), path)),
    ),
  )
  const gitRoot = findGitRoot(getCwd()) ?? getCwd()
  const sessionFiles = data.files.filter((file) =>
    editedPaths.has(resolve(gitRoot, file.path)),
  )
  const otherFiles = data.files.filter(
    (file) => !editedPaths.has(resolve(gitRoot, file.path)),
  )
  const selected = data.files.find((file) => file.path === selectedPath)
  const fileRow = (file: DiffFile) => (
    <Box
      key={file.path}
      flexShrink={0}
      onClick={() => setSelectedPath(file.path)}
    >
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">{file.path}</Text>
      </Box>
      <Text color="diffAdded"> +{file.linesAdded}</Text>
      <Text color="diffRemoved"> -{file.linesRemoved}</Text>
    </Box>
  )

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      overflow="hidden"
      borderStyle="single"
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      paddingX={1}
    >
      <Box flexShrink={0} justifyContent="space-between">
        <Text bold>Diff · working tree</Text>
        <Box onClick={onClose}>
          <Text>✕</Text>
        </Box>
      </Box>
      <Text dimColor>git diff HEAD · /diff to close</Text>
      {selected && (
        <Box flexShrink={0} onClick={() => setSelectedPath(null)}>
          <Text color="suggestion">‹ Back to files</Text>
        </Box>
      )}
      <ScrollBox
        key={selected?.path ?? 'files'}
        ref={scrollRef}
        flexGrow={1}
        flexDirection="column"
      >
        {data.loading ? (
          <Text dimColor>Loading diff…</Text>
        ) : selected ? (
          <DiffDetailView
            filePath={selected.path}
            hunks={data.hunks.get(selected.path) ?? []}
            isBinary={selected.isBinary}
            isLargeFile={selected.isLargeFile}
            isTruncated={selected.isTruncated}
            isUntracked={selected.isUntracked}
          />
        ) : (
          <>
            {data.stats === null ? (
              <Text dimColor>Git diff unavailable</Text>
            ) : data.stats.filesCount === 0 ? (
              <Text dimColor>Working tree is clean</Text>
            ) : (
              <>
                <Text bold>Files edited by tools this session</Text>
                {sessionFiles.length > 0 ? (
                  sessionFiles.map(fileRow)
                ) : (
                  <Text dimColor>No uncommitted tool edits this session</Text>
                )}
                {showOther && (
                  <Box flexDirection="column" marginTop={1} flexShrink={0}>
                    <Text bold>Other working tree changes</Text>
                    {otherFiles.map(fileRow)}
                  </Box>
                )}
                {data.stats.filesCount > data.files.length && (
                  <Text dimColor>
                    Showing {data.files.length} of {data.stats.filesCount} files
                    (detail limit)
                  </Text>
                )}
              </>
            )}
          </>
        )}
      </ScrollBox>
      {!selected && otherFiles.length > 0 && (
        <Box flexShrink={0} onClick={() => setShowOther((value) => !value)}>
          <Text color="suggestion">
            Other working tree changes ({otherFiles.length}) (
            {showOther ? 'hide' : 'show'})
          </Text>
        </Box>
      )}
    </Box>
  )
}
