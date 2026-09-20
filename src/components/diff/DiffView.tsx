import type { StructuredPatchHunk } from 'diff'
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useDiffData, type DiffData } from '../../hooks/useDiffData.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useTurnDiffs } from '../../hooks/useTurnDiffs.js'
import { useTasksV2 } from '../../hooks/useTasksV2.js'
import { isTodoV2Enabled } from '../../utils/tasks.js'
import { Box, Text, useStdin } from '../../ink.js'
import ScrollBox, {
  type ScrollBoxHandle,
} from '../../ink/components/ScrollBox.js'
import type { DOMElement } from '../../ink/dom.js'
import type { InputEvent } from '../../ink/events/input-event.js'
import { getRootNode } from '../../ink/focus.js'
import { hitTest } from '../../ink/hit-test.js'
import { useRegisterKeybindingContext } from '../../keybindings/KeybindingContext.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { DiffController } from '../../services/diff/controller.js'
import { isDiffNoise } from '../../services/diff/classify.js'
import type { Message } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { DiffDetailView, limitDiffHunks } from './DiffDetailView.js'
import { DiffFileList } from './DiffFileList.js'
import { diffDisplayText } from './displayText.js'

type Props = {
  messages: Message[]
  controller?: DiffController
  presentation: 'sidebar' | 'dialog'
  keyboardEnabled?: boolean
  onClose: () => void
}

export function DiffView({
  messages,
  controller: supplied,
  presentation,
  keyboardEnabled = false,
  onClose,
}: Props): React.ReactNode {
  const controller = useMemo(
    () => supplied ?? new DiffController({ cwd: getCwd() }),
    [supplied],
  )
  useEffect(
    () => () => {
      if (!supplied) controller.dispose()
    },
    [controller, supplied],
  )
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  )
  const current = useDiffData(controller)
  const turns = useTurnDiffs(messages)
  const turn = turns.find(item => item.turnIndex === state.source)
  const data = useMemo((): DiffData => {
    const turn = turns.find(item => item.turnIndex === state.source)
    if (!turn) return current
    return {
      stats: {
        filesCount: turn.stats.filesChanged,
        linesAdded: turn.stats.linesAdded,
        linesRemoved: turn.stats.linesRemoved,
      },
      files: [...turn.files.values()]
        .map(file => ({
          path: file.filePath,
          linesAdded: file.linesAdded,
          linesRemoved: file.linesRemoved,
          isNewFile: file.isNewFile,
          isNoise: isDiffNoise(file.filePath),
          isBinary: false,
          isLargeFile: false,
          isTruncated: file.isTruncated ?? false,
          bodyState: 'ready' as const,
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      hunks: new Map(
        [...turn.files.values()].map(file => [file.filePath, file.hunks]),
      ),
      loading: false,
      outcome: 'data',
      baseLabel: `Turn ${turn.turnIndex}`,
    }
  }, [turns, state.source, current])
  const visible = useMemo(
    () =>
      data.files.filter(
        file =>
          (state.showNoise || !file.isNoise) &&
          (state.showPreSession || !file.isPreSession),
      ),
    [data.files, state.showNoise, state.showPreSession],
  )
  const selectedIndex = Math.max(
    0,
    visible.findIndex(file => file.path === state.selectedPath),
  )
  const selected = visible[selectedIndex]
  const [detail, setDetail] = useState(false)
  const listRef = useRef<ScrollBoxHandle>(null)
  const bodyRef = useRef<ScrollBoxHandle>(null)
  const fileAnchors = useRef(new Map<string, DOMElement>())
  const rowAnchors = useRef(new Map<string, DOMElement>())
  const { columns, rows } = useTerminalSize()
  const width = Math.max(1, columns - (presentation === 'sidebar' ? 3 : 4))
  const height = Math.max(5, rows - (presentation === 'dialog' ? 8 : 1))
  const compact = height < 14
  const summaryFiles = visible.slice(0, 50)
  const summaryHeight = Math.max(
    1,
    Math.min(8, summaryFiles.length, Math.floor((height - 5) / 3)),
  )
  const sources = [null, ...turns.map(item => item.turnIndex)]
  const sourceIndex = Math.max(0, sources.indexOf(state.source))
  const basis = turn
    ? `Turn ${turn.turnIndex}`
    : (data.baseLabel ?? state.mode)
  const noiseCount = data.files.filter(file => file.isNoise).length
  const preSessionCount = data.files.filter(
    file => file.isPreSession,
  ).length
  const dismissShortcut = useShortcutDisplay(
    'diff:dismiss',
    'DiffDialog',
    'esc',
  )

  const tasks = useTasksV2()
  const tasksEnabled = isTodoV2Enabled()
  const todos = useMemo(() => {
    if (tasksEnabled) {
      return {
        total: tasks?.length ?? 0,
        done: tasks?.filter(task => task.status === 'completed').length ?? 0,
      }
    }
    let statuses: unknown[] = []
    for (const message of messages) {
      if (message.type !== 'assistant') continue
      for (const block of message.message.content) {
        if (block.type !== 'tool_use' || block.name !== 'TodoWrite')
          continue
        const input = block.input
        statuses =
          input &&
          typeof input === 'object' &&
          'todos' in input &&
          Array.isArray(input.todos)
            ? input.todos.map(todo =>
                todo && typeof todo === 'object' ? todo.status : undefined,
              )
            : []
      }
    }
    return {
      total: statuses.length,
      done: statuses.filter(status => status === 'completed').length,
    }
  }, [messages, tasks, tasksEnabled])

  useEffect(() => {
    if (state.source !== null && !turn) controller.chooseSource(null)
  }, [controller, state.source, turn])
  useEffect(() => {
    if (
      state.selectedPath &&
      !visible.some(file => file.path === state.selectedPath)
    ) {
      controller.selectFile(null)
      setDetail(false)
    }
  }, [controller, state.selectedPath, visible])
  useEffect(() => {
    listRef.current?.scrollTo(0)
    bodyRef.current?.scrollTo(0)
    setDetail(false)
  }, [state.source, state.mode])
  const selectedPath = selected?.path
  useEffect(() => {
    if (!selectedPath) return
    const row = rowAnchors.current.get(selectedPath)
    if (row) listRef.current?.scrollToElement(row)
  }, [selectedPath])

  const { internal_eventEmitter } = useStdin()
  useEffect(() => {
    const capture = (event: InputEvent) => {
      const pointer = event.keypress.pointer
      if (!pointer || !(event.key.wheelUp || event.key.wheelDown)) return
      for (const ref of [listRef, bodyRef]) {
        const viewport = ref.current?.getElement()
        if (!viewport) continue
        let hit: DOMElement | undefined =
          hitTest(getRootNode(viewport), pointer.column, pointer.row) ??
          undefined
        while (hit && hit !== viewport) hit = hit.parentNode
        if (!hit) continue
        event.stopImmediatePropagation()
        ref.current?.scrollBy(event.key.wheelUp ? -3 : 3)
        return
      }
    }
    internal_eventEmitter?.prependListener('input', capture)
    return () => {
      internal_eventEmitter?.removeListener('input', capture)
    }
  }, [internal_eventEmitter])

  function select(path: string, open = false) {
    controller.selectFile(path)
    if (presentation === 'dialog' && open) {
      setDetail(true)
      bodyRef.current?.scrollTo(0)
    } else {
      const anchor = fileAnchors.current.get(path)
      if (anchor) bodyRef.current?.scrollToElement(anchor)
    }
  }
  function moveFile(delta: number) {
    if (detail) {
      bodyRef.current?.scrollBy(delta * 3)
    } else {
      const file =
        visible[
          Math.max(0, Math.min(visible.length - 1, selectedIndex + delta))
        ]
      if (file) select(file.path)
    }
  }
  function moveSource(delta: number) {
    controller.chooseSource(
      sources[
        Math.max(0, Math.min(sources.length - 1, sourceIndex + delta))
      ] ?? null,
    )
  }
  useRegisterKeybindingContext('DiffDialog', keyboardEnabled)
  useKeybindings(
    {
      'diff:dismiss': () => {
        if (detail) setDetail(false)
        else onClose()
      },
      'diff:previousSource': () => {
        if (detail) setDetail(false)
        else moveSource(-1)
      },
      'diff:nextSource': () => {
        if (!detail) moveSource(1)
      },
      'diff:back': () => setDetail(false),
      'diff:viewDetails': () => {
        if (selected) select(selected.path, true)
      },
      'diff:previousFile': () => moveFile(-1),
      'diff:nextFile': () => moveFile(1),
    },
    { context: 'DiffDialog', isActive: keyboardEnabled },
  )
  useKeybindings(
    {
      'scroll:pageUp': () => {
        const target =
          detail || presentation === 'sidebar'
            ? bodyRef.current
            : listRef.current
        target?.scrollBy(-Math.max(1, target.getViewportHeight() - 1))
      },
      'scroll:pageDown': () => {
        const target =
          detail || presentation === 'sidebar'
            ? bodyRef.current
            : listRef.current
        target?.scrollBy(Math.max(1, target.getViewportHeight() - 1))
      },
      'scroll:top': () => {
        const target =
          detail || presentation === 'sidebar'
            ? bodyRef.current
            : listRef.current
        target?.scrollTo(0)
      },
      'scroll:bottom': () => {
        const target =
          detail || presentation === 'sidebar'
            ? bodyRef.current
            : listRef.current
        target?.scrollTo(target.getScrollHeight())
      },
    },
    { context: 'Scroll', isActive: keyboardEnabled },
  )

  const bodies = useMemo(() => {
    const budget = {
      chars: 70_000,
      nodes: Math.max(0, 1360 - summaryFiles.length * 8),
    }
    let preSession = 0
    let omitted = 0
    let preSessionOmitted = 0
    const files =
      detail && presentation === 'dialog'
        ? selected
          ? [selected]
          : []
        : visible
    const entries: {
      file: (typeof visible)[number]
      hunks: StructuredPatchHunk[]
      truncated: boolean
    }[] = []
    for (const file of files) {
      if (file.isPreSession && ++preSession > 20) {
        preSessionOmitted++
        continue
      }
      if (budget.nodes < 20 || budget.chars < file.path.length + 100) {
        omitted++
        continue
      }
      budget.nodes -= 20
      budget.chars -= file.path.length + 100
      const limited = limitDiffHunks(
        data.hunks.get(file.path) ?? [],
        budget,
        width,
      )
      entries.push({
        file,
        hunks: limited.hunks,
        truncated: limited.truncated,
      })
    }
    return { entries, omitted, preSessionOmitted }
  }, [
    visible,
    data.hunks,
    selected,
    detail,
    presentation,
    width,
    summaryFiles.length,
  ])
  let emptyMessage = 'No visible changes (check filters)'
  if (!data.files.length) {
    emptyMessage = data.loading
      ? 'Loading diff…'
      : data.outcome === 'no-repository'
        ? 'Not a Git repository'
        : data.outcome === 'unavailable' || data.stats === null
          ? 'Git diff unavailable'
          : (data.stats?.filesCount ?? 0) > 0
            ? 'Too many files to display details'
            : turn
              ? 'No file changes in this turn'
              : data.isUntrackedWithheld
                ? 'No tracked changes'
                : 'Working tree is clean'
  }
  const content = (
    <Box
      flexDirection="column"
      height={height}
      maxHeight="100%"
      flexGrow={1}
      minHeight={0}
      overflow="hidden"
    >
      <Box flexShrink={0} justifyContent="space-between">
        <Text bold>Diff</Text>
        <Box onClick={onClose}>
          <Text>✕</Text>
        </Box>
      </Box>
      <Box flexShrink={0}>
        <Box onClick={() => controller.cycleBase()}>
          <Text color="suggestion">Base: {state.mode}</Text>
        </Box>
        <Box
          marginLeft={1}
          flexShrink={1}
          onClick={() =>
            moveSource(
              sourceIndex === sources.length - 1 ? -sourceIndex : 1,
            )
          }
        >
          <Text color="suggestion" wrap="truncate-end">
            Source: {turn ? `Turn ${turn.turnIndex}` : 'Current'}
          </Text>
        </Box>
      </Box>
      {!compact && (
        <Text dimColor wrap="truncate-end">
          {data.isUnborn && (data.stats?.filesCount ?? data.files.length) > 0
            ? 'no commits yet — showing staged and new files'
            : diffDisplayText(basis)}
          {turn?.userPromptPreview
            ? ` · ${diffDisplayText(turn.userPromptPreview)}`
            : ''}
        </Text>
      )}
      <Box flexShrink={0}>
        <Box onClick={() => controller.toggleNoise()}>
          <Text color="suggestion">
            Noise {noiseCount} [{state.showNoise ? 'on' : 'off'}]
          </Text>
        </Box>
        <Box marginLeft={1} onClick={() => controller.togglePreSession()}>
          <Text color="suggestion">
            Pre-session {preSessionCount} [
            {state.showPreSession ? 'on' : 'off'}]
          </Text>
        </Box>
      </Box>
      {!compact && (
        <Text dimColor wrap="truncate-end">
          Todos {todos.done}/{todos.total} · {visible.length}/
          {data.stats?.filesCount ?? data.files.length} files · +
          {data.stats?.linesAdded ?? 0} -{data.stats?.linesRemoved ?? 0}
        </Text>
      )}
      {state.armedPath && (
        <Box
          flexShrink={0}
          onClick={() => controller.toggleAsk(state.armedPath!, [], basis)}
        >
          <Text color="suggestion" wrap="truncate-middle">
            Ask armed: {diffDisplayText(state.armedPath)} · next prompt ·
            cancel
          </Text>
        </Box>
      )}
      {data.loading && data.files.length > 0 && (
        <Text dimColor>Refreshing diff…</Text>
      )}
      {data.outcome === 'unavailable' && data.files.length > 0 && (
        <Text dimColor>Git diff unavailable · showing last good data</Text>
      )}
      {detail && presentation === 'dialog' && (
        <Box onClick={() => setDetail(false)}>
          <Text color="suggestion">‹ Back to files</Text>
        </Box>
      )}
      {!detail && visible.length > 0 && (
        <ScrollBox
          ref={listRef}
          height={summaryHeight}
          flexShrink={0}
          flexDirection="column"
        >
          <DiffFileList
            files={summaryFiles}
            selectedIndex={selectedIndex}
            onSelect={path => select(path, true)}
            rowRef={(path, element) => {
              if (element) rowAnchors.current.set(path, element)
              else rowAnchors.current.delete(path)
            }}
          />
        </ScrollBox>
      )}
      {visible.length > summaryFiles.length && (
        <Text dimColor>Summary truncated at 50 files (render budget)</Text>
      )}
      <ScrollBox
        ref={bodyRef}
        flexGrow={1}
        minHeight={1}
        flexDirection="column"
      >
        {visible.length === 0 ? (
          <Text dimColor>{emptyMessage}</Text>
        ) : (
          bodies.entries.map(({ file, hunks, truncated }) => (
            <Box
              key={file.path}
              flexDirection="column"
              flexShrink={0}
              marginTop={1}
              ref={element => {
                if (element) fileAnchors.current.set(file.path, element)
                else fileAnchors.current.delete(file.path)
              }}
            >
              <DiffDetailView
                filePath={file.path}
                hunks={hunks}
                isBinary={file.isBinary}
                isLargeFile={file.isLargeFile}
                isTruncated={file.isTruncated}
                isUntracked={file.isUntracked}
                bodyState={file.bodyState}
                renderTruncated={truncated}
                width={width}
                armed={state.armedPath === file.path}
                onAsk={() =>
                  controller.toggleAsk(
                    file.path,
                    data.hunks.get(file.path) ?? [],
                    basis,
                  )
                }
              />
            </Box>
          ))
        )}
        {data.isUntrackedWithheld && (
          <Text dimColor>Untracked files unavailable; not counted</Text>
        )}
        {bodies.preSessionOmitted > 0 && (
          <Text dimColor>
            {bodies.preSessionOmitted} pre-session bodies omitted (20 file
            limit)
          </Text>
        )}
        {bodies.omitted > 0 && (
          <Text dimColor>
            {bodies.omitted} file bodies omitted (render budget)
          </Text>
        )}
        {data.stats && data.stats.filesCount > data.files.length && (
          <Text dimColor>
            Showing {data.files.length} of {data.stats.filesCount} files
            (detail limit)
          </Text>
        )}
      </ScrollBox>
    </Box>
  )
  if (presentation === 'sidebar') return content
  return (
    <Dialog
      title={detail ? 'Diff · detail' : 'Diff · files'}
      color="background"
      isCancelActive={keyboardEnabled}
      onCancel={() => {
        if (detail) setDetail(false)
        else onClose()
      }}
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <Byline>
            <Text>
              {detail
                ? '↑/↓ scroll · ← back'
                : '↑/↓ select · ←/→ source · Enter view'}
            </Text>
            <Text>PgUp/PgDn scroll</Text>
            <Text>
              {dismissShortcut} {detail ? 'back' : 'close'}
            </Text>
          </Byline>
        )
      }
    >
      {content}
    </Dialog>
  )
}
