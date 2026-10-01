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
import {
  useKeybinding,
  useKeybindings,
} from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { useIsInsideModal } from '../../context/modalContext.js'
import { DiffController } from '../../services/diff/controller.js'
import { isDiffNoise } from '../../services/diff/classify.js'
import type { Message } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import { plural } from '../../utils/stringUtils.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import {
  DiffDetailView,
  limitDiffHunks,
  useHighlightedDiff,
} from './DiffDetailView.js'
import { DiffFileList, DiffStat } from './DiffFileList.js'
import { diffDisplayText } from './displayText.js'

function visibleFiles(
  files: DiffData['files'],
  showNoise: boolean,
  showPreSession: boolean,
): DiffData['files'] {
  return files
    .filter(
      file =>
        (showNoise || !file.isNoise) &&
        (showPreSession || !file.isPreSession),
    )
    .sort((a, b) => a.path.localeCompare(b.path))
}

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
          isPreSession: false,
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
    () => visibleFiles(data.files, state.showNoise, state.showPreSession),
    [data.files, state.showNoise, state.showPreSession],
  )
  const selectedIndex = Math.max(
    0,
    visible.findIndex(file => file.path === state.selectedPath),
  )
  const selected = visible[selectedIndex]
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const [detail, setDetailState] = useState(false)
  const detailRef = useRef(detail)
  detailRef.current = detail
  const listRef = useRef<ScrollBoxHandle>(null)
  const bodyRef = useRef<ScrollBoxHandle>(null)
  const setDetail = (value: boolean) => {
    detailRef.current = value
    setDetailState(value)
  }
  const fileAnchors = useRef(new Map<string, DOMElement>())
  const rowAnchors = useRef(new Map<string, DOMElement>())
  const { columns, rows } = useTerminalSize()
  // Pane pads by 2 per side, or by 1 inside FullscreenLayout's modal slot,
  // whose own padding is not reflected in the terminal size.
  const insideModal = useIsInsideModal()
  const width = Math.max(
    1,
    columns - (presentation === 'sidebar' ? 2 : insideModal ? 6 : 4),
  )
  const highlighted = useHighlightedDiff()
  const height = Math.max(5, rows - (presentation === 'dialog' ? 8 : 3))
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
    file => file.isPreSession && (state.showNoise || !file.isNoise),
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
    if (!state.selectedPath) return
    const body = fileAnchors.current.get(selectedPath)
    if (body) bodyRef.current?.scrollToElement(body)
  }, [selectedPath, state.selectedPath])

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
    if (open) {
      setDetail(true)
      bodyRef.current?.scrollTo(0)
    }
  }
  function moveFile(delta: number) {
    if (detailRef.current) {
      bodyRef.current?.scrollBy(delta * 3)
    } else {
      const files = visibleRef.current
      const path = controller.getSnapshot().selectedPath
      const index = Math.max(
        0,
        files.findIndex(file => file.path === path),
      )
      const file = files[Math.max(0, Math.min(files.length - 1, index + delta))]
      if (file) select(file.path)
    }
  }
  function moveSource(delta: number) {
    const currentSource = controller.getSnapshot().source
    const index = Math.max(0, sources.indexOf(currentSource))
    const source =
      sources[Math.max(0, Math.min(sources.length - 1, index + delta))] ?? null
    controller.chooseSource(source)
    const sourceTurn = turns.find(item => item.turnIndex === source)
    const files = sourceTurn
      ? [...sourceTurn.files.values()]
          .map(file => ({
            path: file.filePath,
            linesAdded: file.linesAdded,
            linesRemoved: file.linesRemoved,
            isNewFile: file.isNewFile,
            isNoise: isDiffNoise(file.filePath),
            isPreSession: false,
            isBinary: false,
            isLargeFile: false,
            isTruncated: file.isTruncated ?? false,
            bodyState: 'ready' as const,
          }))
          .sort((a, b) => a.path.localeCompare(b.path))
      : current.files
    visibleRef.current = visibleFiles(
      files,
      controller.getSnapshot().showNoise,
      controller.getSnapshot().showPreSession,
    )
  }
  useRegisterKeybindingContext('DiffDialog', keyboardEnabled)
  useKeybindings(
    {
      'app:cycleDiffBase': () => void controller.cycleBase(),
      'app:diffFileListUp': () => moveFile(-1),
      'app:diffFileListDown': () => moveFile(1),
    },
    { context: 'Global' },
  )
  useKeybinding(
    'diff:dismiss',
    () => onClose(),
    {
      context: 'DiffDialog',
      isActive: presentation === 'sidebar' && !keyboardEnabled,
      capture: true,
    },
  )
  useKeybindings(
    {
      'diff:dismiss': () => {
        if (detailRef.current) setDetail(false)
        else onClose()
      },
      'diff:previousSource': () => {
        if (detailRef.current) setDetail(false)
        else moveSource(-1)
      },
      'diff:nextSource': () => {
        if (!detailRef.current) moveSource(1)
      },
      'diff:back': () => setDetail(false),
      'diff:viewDetails': () => {
        const files = visibleRef.current
        const path = controller.getSnapshot().selectedPath
        const file = files.find(item => item.path === path) ?? files[0]
        if (file) select(file.path, true)
      },
      'diff:previousFile': () => moveFile(-1),
      'diff:nextFile': () => moveFile(1),
    },
    { context: 'DiffDialog', isActive: keyboardEnabled, capture: true },
  )
  useKeybindings(
    {
      'scroll:pageUp': () => {
        const target =
          detailRef.current || presentation === 'sidebar'
            ? bodyRef.current
            : listRef.current
        target?.scrollBy(-Math.max(1, target.getViewportHeight() - 1))
      },
      'scroll:pageDown': () => {
        const target =
          detailRef.current || presentation === 'sidebar'
            ? bodyRef.current
            : listRef.current
        target?.scrollBy(Math.max(1, target.getViewportHeight() - 1))
      },
      'scroll:top': () => {
        const target =
          detailRef.current || presentation === 'sidebar'
            ? bodyRef.current
            : listRef.current
        target?.scrollTo(0)
      },
      'scroll:bottom': () => {
        const target =
          detailRef.current || presentation === 'sidebar'
            ? bodyRef.current
            : listRef.current
        target?.scrollTo(target.getScrollHeight())
      },
    },
    { context: 'Scroll', isActive: keyboardEnabled, capture: true },
  )

  const bodies = useMemo(() => {
    const budget = {
      chars: 70_000,
      nodes: Math.max(0, 1360 - summaryFiles.length * 8),
    }
    let preSession = 0
    let omitted = 0
    let preSessionOmitted = 0
    const files = detail
      ? selected
        ? [selected]
        : []
      : selected
        ? [selected, ...visible.filter(file => file.path !== selected.path)]
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
      // Heading, two dividers and notices.
      const frameChars = file.path.length + 100 + 2 * width
      if (budget.nodes < 20 || budget.chars < frameChars) {
        omitted++
        continue
      }
      budget.nodes -= 20
      budget.chars -= frameChars
      const limited = limitDiffHunks(
        data.hunks.get(file.path) ?? [],
        budget,
        width,
        highlighted,
      )
      entries.push({
        file,
        hunks: limited.hunks,
        truncated: limited.truncated,
      })
    }
    const order = new Map(visible.map((file, index) => [file.path, index]))
    entries.sort(
      (left, right) =>
        (order.get(left.file.path) ?? 0) - (order.get(right.file.path) ?? 0),
    )
    return { entries, omitted, preSessionOmitted }
  }, [
    visible,
    data.hunks,
    selected,
    detail,
    width,
    highlighted,
    summaryFiles.length,
  ])
  const branchLabel = data.baseLabel?.startsWith('vs ')
    ? diffDisplayText(data.baseLabel)
    : undefined
  let emptyMessage =
    turn
      ? 'No file changes in this turn'
      : state.mode === 'uncommitted'
        ? 'No uncommitted changes'
        : state.mode === 'branch'
          ? `No changes ${branchLabel ?? 'vs HEAD'}`
          : 'No changes this session'
  if (!data.files.length) {
    emptyMessage = data.loading
      ? 'Loading diff…'
      : data.outcome === 'no-repository'
        ? 'Not a Git repository'
        : data.outcome === 'unavailable' || data.stats === null
          ? 'Git diff unavailable'
          : (data.stats?.filesCount ?? 0) > 0
            ? 'Too many files to display details'
            : !turn && data.isUntrackedWithheld
              ? 'No tracked changes'
              : emptyMessage
  }
  const baseLine = turn
    ? turn.userPromptPreview
      ? `Turn ${turn.turnIndex} "${diffDisplayText(turn.userPromptPreview)}"`
      : `Turn ${turn.turnIndex}`
    : data.isUnborn && (data.stats?.filesCount ?? data.files.length) > 0
      ? 'no commits yet — showing staged and new files'
      : state.mode === 'uncommitted'
        ? 'uncommitted (vs HEAD)'
        : state.mode === 'branch'
          ? branchLabel
            ? `branch ${branchLabel}`
            : 'vs HEAD (no base branch)'
          : null
  const totals = visible.reduce(
    (sum, file) => ({
      added: sum.added + file.linesAdded,
      removed: sum.removed + file.linesRemoved,
    }),
    { added: 0, removed: 0 },
  )
  const body = (
    <ScrollBox
      ref={bodyRef}
      flexGrow={1}
      minHeight={1}
      marginTop={1}
      flexDirection="column"
    >
      {bodies.entries.map(({ file, hunks, truncated }) => (
        <Box
          key={file.path}
          flexDirection="column"
          flexShrink={0}
          marginBottom={1}
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
      ))}
      {data.isUntrackedWithheld && (
        <Text dimColor>Untracked files unavailable; not counted</Text>
      )}
      {bodies.preSessionOmitted > 0 && (
        <Text dimColor>
          {bodies.preSessionOmitted} pre-session bodies omitted (20 file limit)
        </Text>
      )}
      {bodies.omitted > 0 && (
        <Text dimColor>
          {bodies.omitted} file bodies omitted (render budget)
        </Text>
      )}
      {data.stats && data.stats.filesCount > data.files.length && (
        <Text dimColor>
          Showing {data.files.length} of {data.stats.filesCount} files (detail
          limit)
        </Text>
      )}
    </ScrollBox>
  )
  const content = (
    <Box
      flexDirection="column"
      height={presentation === 'sidebar' ? undefined : height}
      maxHeight="100%"
      flexGrow={1}
      minHeight={0}
      overflow="hidden"
    >
      <Box flexShrink={0} width="100%">
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {visible.length > 0 && (
            <Text wrap="truncate-end">
              <Text bold>
                {visible.length} {plural(visible.length, 'file')} changed
              </Text>
              {(totals.added > 0 || totals.removed > 0) && ' '}
              <DiffStat added={totals.added} removed={totals.removed} />
            </Text>
          )}
        </Box>
        <Box flexShrink={0} marginLeft={1} onClick={onClose}>
          <Text dimColor>✕</Text>
        </Box>
      </Box>
      {baseLine && (
        <Box flexShrink={0}>
          <Text dimColor wrap="truncate-end">
            {baseLine}
          </Text>
        </Box>
      )}
      {!compact && (
        <Box flexShrink={0}>
          <Box flexShrink={0} onClick={() => controller.cycleBase()}>
            <Text dimColor>Base: {state.mode}</Text>
          </Box>
          <Text dimColor> · </Text>
          <Box
            flexShrink={1}
            minWidth={0}
            onClick={() =>
              moveSource(
                sourceIndex === sources.length - 1 ? -sourceIndex : 1,
              )
            }
          >
            <Text dimColor wrap="truncate-end">
              Source: {turn ? `Turn ${turn.turnIndex}` : 'Current'}
            </Text>
          </Box>
          {todos.total > 0 && (
            <Box flexShrink={0}>
              <Text dimColor>
                {' '}
                · Todos {todos.done}/{todos.total}
              </Text>
            </Box>
          )}
        </Box>
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
      {detail && (
        <Box onClick={() => setDetail(false)}>
          <Text color="suggestion">‹ Back to files</Text>
        </Box>
      )}
      {!detail && (
        <Box flexDirection="column" flexShrink={0} marginTop={compact ? 0 : 1}>
          {visible.length > 0 && (
            <ScrollBox
              ref={listRef}
              height={summaryHeight}
              flexShrink={0}
              flexDirection="column"
            >
              <DiffFileList
                files={summaryFiles}
                selectedIndex={selectedIndex}
                showSelection={keyboardEnabled}
                onSelect={path => select(path, presentation === 'dialog')}
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
          {noiseCount > 0 && (
            <Box flexShrink={0} onClick={() => controller.toggleNoise()}>
              <Text dimColor wrap="truncate-end">
                {`${noiseCount} ${plural(noiseCount, 'test')}/generated (${state.showNoise ? 'hide' : 'show'})`}
              </Text>
            </Box>
          )}
          {preSessionCount > 0 && (
            <Box flexShrink={0} onClick={() => controller.togglePreSession()}>
              <Text dimColor wrap="truncate-end">
                {`+${preSessionCount} ${plural(preSessionCount, 'file')} edited before this session (${state.showPreSession ? 'hide' : 'show'})`}
              </Text>
            </Box>
          )}
        </Box>
      )}
      {visible.length === 0 ? (
        <Box
          flexGrow={1}
          minHeight={1}
          flexDirection="column"
          justifyContent="center"
          alignItems="center"
        >
          <Text dimColor wrap="truncate-end">
            {emptyMessage}
          </Text>
          {data.isUntrackedWithheld && (
            <Text dimColor>Untracked files unavailable; not counted</Text>
          )}
        </Box>
      ) : (
        body
      )}
    </Box>
  )
  if (presentation === 'sidebar') {
    return (
      <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
        {content}
        {keyboardEnabled && (
          <Box flexShrink={0} paddingTop={1}>
            <Text dimColor wrap="truncate-end">
              {detail
                ? '↑/↓ scroll · ← back · Esc back'
                : '↑/↓ select · Enter view · PgUp/PgDn scroll · Esc close'}
            </Text>
          </Box>
        )}
      </Box>
    )
  }
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
