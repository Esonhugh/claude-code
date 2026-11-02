import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { getRemoteTaskControl } from '../../remote/remoteTaskControl.js'
import { useAppState } from '../../state/AppState.js'
import type { RemoteTaskProjection as MutableRemoteTask } from '../../state/AppStateStore.js'
import type { DeepImmutable } from '../../types/utils.js'
import { errorMessage } from '../../utils/errors.js'
import { normalizeTerminalPreview } from '../../utils/pty/previewText.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import TextInput from '../TextInput.js'

type Props = {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}

type RemoteTaskProjection = DeepImmutable<MutableRemoteTask>

const MESSAGE_TASK_TYPES = new Set(['local_agent', 'in_process_teammate'])
const OUTPUT_TASK_TYPES = new Set(['local_bash', 'interactive_terminal', 'monitor_mcp'])
const OUTPUT_LINES = 12

function usageLine(task: RemoteTaskProjection): string {
  const parts = [task.taskType ?? 'task']
  if (task.usage) {
    parts.push(formatDuration(task.usage.durationMs))
    parts.push(`${formatNumber(task.usage.totalTokens)} tokens`)
    parts.push(`${task.usage.toolUses} tool uses`)
  }
  if (task.lastToolName) parts.push(task.lastToolName)
  return parts.join(' · ')
}

/**
 * /tasks for `claude ssh` and Direct Connect: the tasks run in the remote
 * headless child, so they are read from AppState.remoteTasks and steered with
 * control requests (send_task_message, stop_task, get_task_output).
 */
export function RemoteTasksDialog({ onDone }: Props): React.ReactNode {
  const remoteTasks = useAppState(s => s.remoteTasks)
  const tasks = Object.values(remoteTasks)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const detail = detailId ? remoteTasks[detailId] : undefined

  useEffect(() => {
    if (detailId && !detail) setDetailId(null)
    if (selectedIndex >= tasks.length && tasks.length > 0) setSelectedIndex(tasks.length - 1)
  }, [detailId, detail, selectedIndex, tasks.length])

  const stop = useCallback((taskId: string) => {
    getRemoteTaskControl()
      ?.stopTask(taskId)
      .then(
        () => setNotice('Stop requested'),
        error => setNotice(errorMessage(error)),
      )
  }, [])

  useKeybindings(
    {
      'confirm:previous': () => setSelectedIndex(i => Math.max(0, i - 1)),
      'confirm:next': () => setSelectedIndex(i => Math.min(tasks.length - 1, i + 1)),
      'confirm:yes': () => {
        const task = tasks[selectedIndex]
        if (task) {
          setNotice(null)
          setDetailId(task.taskId)
        }
      },
    },
    { context: 'Confirmation', isActive: !detail },
  )

  if (detail) {
    return (
      <RemoteTaskDetail
        task={detail}
        onBack={() => {
          setNotice(null)
          setDetailId(null)
        }}
        onStop={() => stop(detail.taskId)}
      />
    )
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'x' && tasks[selectedIndex]) {
      e.preventDefault()
      stop(tasks[selectedIndex]!.taskId)
    }
  }

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="Remote background tasks"
        subtitle={<Text dimColor>{tasks.length} running in the remote session</Text>}
        onCancel={() => onDone('Background tasks dialog dismissed', { display: 'system' })}
        color="background"
        inputGuide={() => (
          <Byline>
            <KeyboardShortcutHint shortcut="↑/↓" action="select" />
            <KeyboardShortcutHint shortcut="enter" action="view" />
            <KeyboardShortcutHint shortcut="x" action="stop" />
            <KeyboardShortcutHint shortcut="esc" action="close" />
          </Byline>
        )}
      >
        {tasks.length === 0 ? (
          <Text dimColor>No tasks currently running</Text>
        ) : (
          <Box flexDirection="column">
            {tasks.map((task, index) => (
              <Box key={task.taskId} flexDirection="row" gap={1}>
                <Text color={index === selectedIndex ? 'suggestion' : undefined}>
                  {index === selectedIndex ? '›' : ' '}
                </Text>
                <Text bold={index === selectedIndex} wrap="truncate-end">
                  {task.description}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {usageLine(task)}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        {notice && <Text dimColor>{notice}</Text>}
      </Dialog>
    </Box>
  )
}

function RemoteTaskDetail({
  task,
  onBack,
  onStop,
}: {
  task: RemoteTaskProjection
  onBack: () => void
  onStop: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const canMessage = MESSAGE_TASK_TYPES.has(task.taskType ?? '')
  const hasOutput = OUTPUT_TASK_TYPES.has(task.taskType ?? '')
  const [draft, setDraft] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [output, setOutput] = useState<string | null>(null)

  // Esc goes back; Settings context keeps letters typeable in the message field.
  useKeybinding('confirm:no', onBack, { context: 'Settings' })

  useEffect(() => {
    if (!hasOutput) return
    let cancelled = false
    const read = () => {
      getRemoteTaskControl()
        ?.getTaskOutput(task.taskId)
        .then(
          text => !cancelled && setOutput(text),
          error => !cancelled && setOutput(errorMessage(error)),
        )
    }
    read()
    const timer = setInterval(read, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [hasOutput, task.taskId])

  const submit = () => {
    const text = draft.trim()
    const control = getRemoteTaskControl()
    if (!text || sending || !control) return
    setSending(true)
    control.sendTaskMessage(task.taskId, text).then(
      delivery => {
        setDraft('')
        setCursorOffset(0)
        setStatus(
          delivery === 'queued'
            ? 'Message queued; the agent gets it at its next tool round'
            : delivery === 'resumed'
              ? 'Agent resumed with your message'
              : 'Message sent',
        )
        setSending(false)
      },
      error => {
        setStatus(errorMessage(error))
        setSending(false)
      },
    )
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!canMessage && e.key === 'x') {
      e.preventDefault()
      onStop()
    }
  }

  const outputLines = output ? normalizeTerminalPreview(output).split('\n').slice(-OUTPUT_LINES) : []
  const progress = task.workflowProgress ?? []

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title={task.description}
        subtitle={<Text dimColor>{usageLine(task)}</Text>}
        onCancel={onBack}
        color="background"
        isCancelActive={false}
        inputGuide={() => (
          <Byline>
            {canMessage && <KeyboardShortcutHint shortcut="enter" action="send" />}
            {!canMessage && <KeyboardShortcutHint shortcut="x" action="stop" />}
            <KeyboardShortcutHint shortcut="esc" action="back" />
          </Byline>
        )}
      >
        <Box flexDirection="column">
          {task.summary && <Text wrap="wrap">{task.summary}</Text>}
          {progress.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {progress.map((item, index) => (
                <Text key={index} dimColor={item.status === 'pending'}>
                  {item.type === 'agent' ? '    ' : '  '}
                  {item.label ?? item.type} · {item.status ?? 'pending'}
                </Text>
              ))}
            </Box>
          )}
          {hasOutput && (
            <Box flexDirection="column" marginTop={1}>
              {outputLines.length === 0 ? (
                <Text dimColor>No output yet</Text>
              ) : (
                outputLines.map((line, index) => (
                  <Text key={index} wrap="truncate-end">
                    {line}
                  </Text>
                ))
              )}
            </Box>
          )}
          {canMessage && (
            <Box flexDirection="row" gap={1} marginTop={1}>
              <Text>{'>'}</Text>
              <TextInput
                value={draft}
                onChange={setDraft}
                onSubmit={submit}
                focus={!sending}
                showCursor={!sending}
                columns={columns - 6}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                placeholder={`Message ${task.description}`}
              />
            </Box>
          )}
          {status && <Text dimColor>{status}</Text>}
        </Box>
      </Dialog>
    </Box>
  )
}
