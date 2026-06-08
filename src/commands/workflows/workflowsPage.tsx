import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Byline } from '../../components/design-system/Byline.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { WorkflowDetailDialog } from '../../components/tasks/WorkflowDetailDialog.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import {
  killWorkflowTask,
  pauseWorkflowTask,
  resumeWorkflowTask,
  retryWorkflowAgent,
  skipWorkflowAgent,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { TaskState } from '../../tasks/types.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { call as callTextWorkflows } from './workflows.js'
import {
  shouldOpenWorkflowsPageForArgs,
  workflowDialogDismissedMessage,
} from './workflowsMessages.js'
import {
  completedCount,
  formatWorkflowEmptyState,
  getWorkflowPageItems,
  runningCount,
  type WorkflowPageItem,
} from './workflowsPageModel.js'

type Props = {
  onComplete: LocalJSXCommandOnDone
}

type ViewState = { mode: 'list' } | { mode: 'detail'; taskId: string }

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const trimmedArgs = args?.trim() ?? ''
  if (trimmedArgs && !shouldOpenWorkflowsPageForArgs(trimmedArgs)) {
    const result = await callTextWorkflows(trimmedArgs, context)
    if (result.type === 'text') {
      onDone(result.value, { display: 'system' })
    } else {
      onDone(undefined, { display: 'skip' })
    }
    return null
  }

  return <WorkflowsPage onComplete={onDone} />
}

function WorkflowListRow({ item, isSelected }: { item: WorkflowPageItem; isSelected: boolean }): React.ReactNode {
  const name = item.title.length > 50 ? item.title.slice(0, 49) + '…' : item.title
  const pointer = isSelected ? '❯ ' : '  '
  return (
    <Box>
      <Text>{pointer}</Text>
      <Text color={isSelected ? 'suggestion' : undefined}>
        <Text color={item.iconColor}>{item.icon}</Text>
        {' '}{name}
        <Text dimColor>{'  '}{item.metricsText}</Text>
      </Text>
    </Box>
  )
}

export function WorkflowsPage({ onComplete }: Props): React.ReactNode {
  const tasks = useAppState(s => s.tasks) as Record<string, TaskState> | undefined
  const setAppState = useSetAppState()
  const [viewState, setViewState] = useState<ViewState>({ mode: 'list' })
  const [selectedIndex, setSelectedIndex] = useState(0)
  const workflowItems = useMemo(() => getWorkflowPageItems(tasks), [tasks])
  const autoJumped = useRef(false)
  useRegisterOverlay('workflows-page')

  const close = useCallback(() => {
    onComplete(workflowDialogDismissedMessage, { display: 'system' })
  }, [onComplete])

  const goBackToList = useCallback(() => {
    if (autoJumped.current && workflowItems.length <= 1) {
      close()
    } else {
      setViewState({ mode: 'list' })
    }
  }, [workflowItems.length, close])

  // Auto-jump to detail when only 1 workflow
  useEffect(() => {
    if (!autoJumped.current && workflowItems.length === 1 && viewState.mode === 'list') {
      autoJumped.current = true
      setViewState({ mode: 'detail', taskId: workflowItems[0]!.id })
    }
  }, [workflowItems, viewState.mode])

  useEffect(() => {
    if (selectedIndex >= workflowItems.length && workflowItems.length > 0) {
      setSelectedIndex(workflowItems.length - 1)
    }
    if (viewState.mode === 'detail') {
      const task = tasks?.[viewState.taskId]
      if (!task || task.type !== 'local_workflow') {
        setViewState({ mode: 'list' })
      }
    }
  }, [selectedIndex, tasks, viewState, workflowItems.length])

  const handleKeyDown = useCallback((e: { key: string; ctrl?: boolean; meta?: boolean; preventDefault: () => void }) => {
    if (e.ctrl || e.meta) return
    if (viewState.mode !== 'list') return
    const selected = workflowItems[selectedIndex]
    if (e.key === 'x' && selected?.status === 'running') {
      e.preventDefault()
      killWorkflowTask(selected.id, setAppState)
    }
  }, [viewState.mode, workflowItems, selectedIndex, setAppState])

  useKeybindings(
    {
      'confirm:no': close,
      'confirm:previous': () => setSelectedIndex(prev => Math.max(0, prev - 1)),
      'confirm:next': () =>
        setSelectedIndex(prev => Math.min(workflowItems.length - 1, prev + 1)),
      'confirm:yes': () => {
        const selected = workflowItems[selectedIndex]
        if (selected) {
          setViewState({ mode: 'detail', taskId: selected.id })
        }
      },
    },
    { context: 'Confirmation', isActive: viewState.mode === 'list' },
  )

  if (viewState.mode === 'detail') {
    const task = tasks?.[viewState.taskId]
    if (task?.type === 'local_workflow') {
      return (
        <WorkflowDetailDialog
          workflow={task}
          onKill={
            task.status === 'running'
              ? () => killWorkflowTask(task.id, setAppState)
              : undefined
          }
          onSkipAgent={
            task.status === 'running'
              ? agentId => skipWorkflowAgent(task.id, agentId, setAppState)
              : undefined
          }
          onRetryAgent={
            task.status === 'running'
              ? agentId => retryWorkflowAgent(task.id, agentId, setAppState)
              : undefined
          }
          onPause={
            task.status === 'running'
              ? () => pauseWorkflowTask(task.id, setAppState)
              : undefined
          }
          onResume={
            task.status === 'pending'
              ? () => resumeWorkflowTask(task.id, setAppState)
              : undefined
          }
          onBack={goBackToList}
        />
      )
    }
  }

  const running = runningCount(workflowItems)
  const completed = completedCount(workflowItems)
  const subtitle = workflowItems.length > 0
    ? [running > 0 && `${running} running`, completed > 0 && `${completed} completed`].filter(Boolean).join(', ')
    : undefined

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="Dynamic workflows"
        subtitle={subtitle}
        onCancel={close}
        color="background"
        inputGuide={() => (
          <Byline>
            {workflowItems.length > 0 && (
              <KeyboardShortcutHint shortcut="↑/↓" action="select" />
            )}
            {workflowItems.length > 0 && (
              <KeyboardShortcutHint shortcut="enter" action="view" />
            )}
            {workflowItems[selectedIndex]?.status === 'running' && (
              <KeyboardShortcutHint shortcut="x" action="stop" />
            )}
            <KeyboardShortcutHint shortcut="escape" action="close" />
          </Byline>
        )}
      >
        {workflowItems.length === 0 ? (
          <Text dimColor>{formatWorkflowEmptyState()}</Text>
        ) : (
          <Box flexDirection="column">
            {workflowItems.map((item, index) => (
              <WorkflowListRow key={item.id} item={item} isSelected={index === selectedIndex} />
            ))}
          </Box>
        )}
      </Dialog>
    </Box>
  )
}
