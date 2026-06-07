import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Byline } from '../../components/design-system/Byline.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { Pane } from '../../components/design-system/Pane.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
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
  formatWorkflowEmptyState,
  formatWorkflowListRow,
  getWorkflowPageItems,
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

export function WorkflowsPage({ onComplete }: Props): React.ReactNode {
  const tasks = useAppState(s => s.tasks) as Record<string, TaskState> | undefined
  const setAppState = useSetAppState()
  const [viewState, setViewState] = useState<ViewState>({ mode: 'list' })
  const [selectedIndex, setSelectedIndex] = useState(0)
  const workflowItems = useMemo(() => getWorkflowPageItems(tasks), [tasks])
  useRegisterOverlay('workflows-page')

  const close = useCallback(() => {
    onComplete(workflowDialogDismissedMessage, { display: 'system' })
  }, [onComplete])

  const goBackToList = useCallback(() => {
    setViewState({ mode: 'list' })
  }, [])

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

  return (
    <Pane color="suggestion">
      <Box flexDirection="column">
        <Text color="suggestion" bold>
          Dynamic workflows
        </Text>
        <Text> </Text>
        {workflowItems.length === 0 ? (
          <Text dimColor>{formatWorkflowEmptyState()}</Text>
        ) : (
          <Box flexDirection="column">
            {workflowItems.map((item, index) => (
              <Text
                key={item.id}
                color={index === selectedIndex ? 'suggestion' : undefined}
              >
                {formatWorkflowListRow(item, index === selectedIndex)}
              </Text>
            ))}
          </Box>
        )}
        <Text> </Text>
        <Byline>
          {workflowItems.length > 0 && [
            <KeyboardShortcutHint
              key="select"
              shortcut="↑/↓"
              action="select"
            />,
            <KeyboardShortcutHint key="view" shortcut="Enter" action="view" />,
          ]}
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Workflows"
            fallback="Esc"
            description="close"
          />
        </Byline>
      </Box>
    </Pane>
  )
}
