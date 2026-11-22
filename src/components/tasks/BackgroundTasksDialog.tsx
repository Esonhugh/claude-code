import { feature } from 'bun:bundle'
import figures from 'figures'
import React, {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react'
import { isCoordinatorMode } from 'src/coordinator/coordinatorMode.js'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import {
  getSessionCronTasks,
  getSessionId,
  removeSessionCronTasks,
  type SessionCronTask,
} from 'src/bootstrap/state.js'
import { clearGoal } from 'src/commands/goal/hooks.js'
import { stringWidth } from 'src/ink/stringWidth.js'
import { useAppState, useSetAppState } from 'src/state/AppState.js'
import {
  enterTeammateView,
  exitTeammateView,
} from 'src/state/teammateViewHelpers.js'
import { createTaskStateBase } from 'src/Task.js'
import type { ToolUseContext } from 'src/Tool.js'
import { cancelLoopWakeups } from 'src/tools/ScheduleWakeupTool/ScheduleWakeupTool.js'
import {
  DreamTask,
  type DreamTaskState,
} from 'src/tasks/DreamTask/DreamTask.js'
import {
  TerminalTask,
  type TerminalTaskState,
} from 'src/tasks/TerminalTask.js'
import { InProcessTeammateTask, isViewableTeammate } from 'src/tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import type { InProcessTeammateTaskState } from 'src/tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from 'src/tasks/LocalAgentTask/LocalAgentTask.js'
import {
  isCompletedBackgroundAgent,
  killAsyncAgent,
} from 'src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from 'src/tasks/LocalShellTask/guards.js'
import { LocalShellTask } from 'src/tasks/LocalShellTask/LocalShellTask.js'
// Type import is erased at build time — safe even though module is ant-gated.
import type { LocalWorkflowTaskState } from 'src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { MonitorMcpTaskState } from 'src/tasks/MonitorMcpTask/MonitorMcpTask.js'
import {
  RemoteAgentTask,
  type RemoteAgentTaskState,
} from 'src/tasks/RemoteAgentTask/RemoteAgentTask.js'
import { type ScriptTaskState, stopScriptTask } from 'src/tasks/ScriptTask/ScriptTask.js'
import {
  type BackgroundTaskState,
  isBackgroundTask,
  type TaskState,
} from 'src/tasks/types.js'
import type { Message } from 'src/types/message.js'
import type { DeepImmutable } from 'src/types/utils.js'
import { intersperse } from 'src/utils/array.js'
import { createAttachmentMessage } from 'src/utils/attachments.js'
import { cronToHuman } from 'src/utils/cron.js'
import { nextCronRunMs } from 'src/utils/cronTasks.js'
import { formatDuration, formatRelativeTimeAgo } from 'src/utils/format.js'
import { isFullscreenActive } from 'src/utils/fullscreen.js'
import { createSystemMessage } from 'src/utils/messages.js'
import {
  listRecordedSubagents,
  type RecordedSubagent,
} from 'src/utils/sessionStorage.js'
import { TEAM_LEAD_NAME } from 'src/utils/swarm/constants.js'
import { truncate } from 'src/utils/truncate.js'
import { stopUltraplan } from '../../commands/ultraplan.js'
import type { CommandResultDisplay } from '../../commands.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import type { ExitState } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { renderAnsiPreviewLine, renderAnsiPreviewLines } from './ansiPreviewRenderer.js'
import {
  terminalPreviewHeight,
  terminalPreviewLines,
  terminalPreviewVisibleRows,
} from './terminalPreview.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { count } from '../../utils/array.js'
import { Select } from '../CustomSelect/select.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { getRemoteTaskControl } from '../../remote/remoteTaskControl.js'
import { RemoteTasksDialog } from './RemoteTasksDialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { AsyncAgentDetailDialog } from './AsyncAgentDetailDialog.js'
import { BackgroundTask as BackgroundTaskComponent } from './BackgroundTask.js'
import { DreamDetailDialog } from './DreamDetailDialog.js'
import { InProcessTeammateDetailDialog } from './InProcessTeammateDetailDialog.js'
import { RemoteSessionDetailDialog } from './RemoteSessionDetailDialog.js'
import { ShellDetailDialog } from './ShellDetailDialog.js'
import {
  type BackgroundTasksDialogScope,
  type BackgroundTasksDialogViewState,
  getBackgroundTasksDialogInitialState,
  getScopedBackgroundTasks,
} from './backgroundTasksDialogState.js'

type Props = {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  /** With setMessages, stopping a row also says so in the transcript. */
  toolUseContext: ToolUseContext & {
    setMessages?: (updater: (prev: Message[]) => Message[]) => void
  }
  initialDetailTaskId?: string
  scope?: BackgroundTasksDialogScope
}

function TerminalDetailDialog({
  task,
  onBack,
}: {
  task: DeepImmutable<TerminalTaskState>
  onBack: () => void
}): React.ReactNode {
  const { rows } = useTerminalSize()
  const visibleRows = terminalPreviewVisibleRows(
    task.rows,
    rows,
    isFullscreenActive(),
  )
  return (
    <Dialog
      title="Terminal details"
      onCancel={onBack}
      color="background"
      inputGuide={() => (
        <Byline>
          <KeyboardShortcutHint shortcut="←/Esc/Enter" action="go back" />
        </Byline>
      )}
    >
      <Box flexDirection="column">
        <Box flexDirection="column" flexShrink={0}>
          <Text>
            <Text bold>Session:</Text> {task.sessionId}
          </Text>
          <Text>
            <Text bold>Status:</Text> {task.closed ? 'closed' : task.status}
          </Text>
          <Text>
            <Text bold>Command:</Text> {task.command}
          </Text>
          <Text>
            <Text bold>Args:</Text> {JSON.stringify(task.args)}
          </Text>
          <Text>
            <Text bold>CWD:</Text> {task.cwd}
          </Text>
          <Text bold>Preview:</Text>
        </Box>
        {/* Shrinks when the dialog area is shorter than the PTY; flex-end keeps
            the newest lines visible and clips the oldest. */}
        <Box
          borderStyle="round"
          paddingX={1}
          flexDirection="column"
          width="100%"
          height={terminalPreviewHeight(visibleRows)}
          overflow="hidden"
          justifyContent="flex-end"
        >
          <Box flexDirection="column" flexShrink={0}>
            {renderAnsiPreviewLines(
              terminalPreviewLines(task.preview, task.rows, visibleRows).join('\n'),
              task.cols,
            ).map(renderAnsiPreviewLine)}
          </Box>
        </Box>
      </Box>
    </Dialog>
  )
}

type TaskListItem =
  | {
      id: string
      type: 'local_bash'
      label: string
      status: string
      task: DeepImmutable<LocalShellTaskState>
    }
  | {
      id: string
      type: 'interactive_terminal'
      label: string
      status: string
      task: DeepImmutable<TerminalTaskState>
    }
  | {
      id: string
      type: 'remote_agent'
      label: string
      status: string
      task: DeepImmutable<RemoteAgentTaskState>
    }
  | {
      id: string
      type: 'local_agent'
      label: string
      status: string
      task: DeepImmutable<LocalAgentTaskState>
    }
  | {
      id: string
      type: 'in_process_teammate'
      label: string
      status: string
      task: DeepImmutable<InProcessTeammateTaskState>
    }
  | {
      id: string
      type: 'local_workflow'
      label: string
      status: string
      task: DeepImmutable<LocalWorkflowTaskState>
    }
  | {
      id: string
      type: 'monitor_mcp'
      label: string
      status: string
      task: DeepImmutable<MonitorMcpTaskState>
    }
  | {
      id: string
      type: 'dream'
      label: string
      status: string
      task: DeepImmutable<DreamTaskState>
    }
  | {
      id: string
      type: 'local_script'
      label: string
      status: string
      task: DeepImmutable<ScriptTaskState>
    }
  | {
      id: string
      type: 'leader'
      label: string
      status: 'running'
    }

// Rows that are not tasks: what official 2.1.329 lists beside them.
type StoppableItem = {
  id: string
  type: 'scheduled' | 'goal'
  label: string
  status: 'running'
  when: string
}
type HistoryItem =
  | {
      id: typeof SUBAGENT_HISTORY_ID
      type: 'subagent_history'
      label: string
      status: 'running'
      size: number
    }
  | {
      id: string
      type: 'recorded_agent'
      label: string
      status: 'completed'
      entry: RecordedSubagent
    }
type ListItem = TaskListItem | StoppableItem | HistoryItem

const SUBAGENT_HISTORY_ID = '__subagent_history__'
const SUBAGENT_HISTORY_LABEL = 'Earlier in this session'
const GOAL_ITEM_ID = '__goal__'
const STOP_TITLES = {
  scheduled: 'Stop this scheduled task?',
  goal: 'Stop the goal?',
}

/* eslint-disable @typescript-eslint/no-require-imports */
const WorkflowDetailDialog = (
  require('./WorkflowDetailDialog.js') as typeof import('./WorkflowDetailDialog.js')
).WorkflowDetailDialog
const workflowTaskModule = require('src/tasks/LocalWorkflowTask/LocalWorkflowTask.js') as typeof import('src/tasks/LocalWorkflowTask/LocalWorkflowTask.js')
const killWorkflowTask = workflowTaskModule.killWorkflowTask
const skipWorkflowAgent = workflowTaskModule.skipWorkflowAgent
const retryWorkflowAgent = workflowTaskModule.retryWorkflowAgent
const pauseWorkflowTask = workflowTaskModule.pauseWorkflowTask
// Relative path, not `src/...` path-mapping — Bun's DCE can statically
// resolve + eliminate `./` requires, but path-mapped strings stay opaque
// and survive as dead literals in the bundle. Matches tasks.ts pattern.
const monitorMcpModule = feature('MONITOR_TOOL')
  ? (require('../../tasks/MonitorMcpTask/MonitorMcpTask.js') as typeof import('../../tasks/MonitorMcpTask/MonitorMcpTask.js'))
  : null
const killMonitorMcp = monitorMcpModule?.killMonitorMcp ?? null
const MonitorMcpDetailDialog = feature('MONITOR_TOOL')
  ? (
      require('./MonitorMcpDetailDialog.js') as typeof import('./MonitorMcpDetailDialog.js')
    ).MonitorMcpDetailDialog
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export function BackgroundTasksDialog(props: Props): React.ReactNode {
  // claude ssh / Direct Connect: the tasks live in the remote child.
  if (getRemoteTaskControl()) return <RemoteTasksDialog onDone={props.onDone} />
  return <LocalBackgroundTasksDialog {...props} />
}

function LocalBackgroundTasksDialog({
  onDone,
  toolUseContext,
  initialDetailTaskId,
  scope = 'all',
}: Props): React.ReactNode {
  const tasks = useAppState(s => s.tasks)
  const foregroundedTaskId = useAppState(s => s.foregroundedTaskId)
  const setAppState = useSetAppState()
  const killAgentsShortcut = useShortcutDisplay(
    'chat:killAgents',
    'Chat',
    'ctrl+x ctrl+k',
  )
  const typedTasks = tasks as Record<string, TaskState> | undefined

  const initialState = getBackgroundTasksDialogInitialState({
    tasks: typedTasks,
    foregroundedTaskId,
    initialDetailTaskId,
    scope,
  })

  // Track if we skipped list view on mount (for back button behavior)
  const skippedListOnMount = useRef(initialState.skippedListOnMount)

  const [viewState, setViewState] = useState<BackgroundTasksDialogViewState>(
    initialState.viewState,
  )
  const [selectedIndex, setSelectedIndex] = useState<number>(
    initialState.initialSelectedIndex,
  )
  const goalStatus = useAppState(s => s.goalStatus)
  const [cronTasks, setCronTasks] = useState(getSessionCronTasks)
  const [recordedAgents, setRecordedAgents] = useState<RecordedSubagent[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [unopenable, setUnopenable] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (scope === 'terminal') return
    let isOpen = true
    void listRecordedSubagents()
      .then(agents => {
        if (isOpen) setRecordedAgents(agents)
      })
      .catch(() => {})
    return () => {
      isOpen = false
    }
  }, [scope])

  // Register as modal overlay so parent Chat keybindings (up/down for history)
  // are deactivated while this dialog is open
  useRegisterOverlay('background-tasks-dialog')

  // Memoize the sorted and categorized items together to ensure stable references
  const {
    bashTasks,
    terminalTasks,
    remoteSessions,
    agentTasks,
    completedAgentTasks,
    teammateTasks,
    mcpMonitors,
    dreamTasks,
    scriptTasks,
    scheduledItems,
    goalItems,
    historyItems,
    allSelectableItems,
  } = useMemo(() => {
    // Filter to only show running/pending background tasks, matching the status bar count.
    // Workflows are steered from CoordinatorTaskPanel so the user selects the
    // visible deep-research/workflow row directly, not a generic Workflows group.
    const backgroundTasks = getScopedBackgroundTasks(
      typedTasks,
      foregroundedTaskId,
      scope,
    )
    const allItems = backgroundTasks.map(toListItem)
    const sorted = allItems.sort((a, b) => {
      const aStatus = a.status
      const bStatus = b.status
      if (aStatus === 'running' && bStatus !== 'running') return -1
      if (aStatus !== 'running' && bStatus === 'running') return 1
      const aTime = 'task' in a ? a.task.startTime : 0
      const bTime = 'task' in b ? b.task.startTime : 0
      return bTime - aTime
    })
    const bash = sorted.filter(item => item.type === 'local_bash')
    const terminals = sorted.filter(
      item => item.type === 'interactive_terminal',
    )
    const remote = sorted.filter(item => item.type === 'remote_agent')
    // Exclude foregrounded task - it's being viewed in the main UI, not a background task
    const localAgents = sorted.filter(
      item => item.type === 'local_agent' && item.id !== foregroundedTaskId,
    )
    const agent = localAgents.filter(
      item => !('task' in item) || !isCompletedBackgroundAgent(item.task),
    )
    const completedAgents = localAgents.filter(
      item => 'task' in item && isCompletedBackgroundAgent(item.task),
    )
    const monitorMcp = sorted.filter(item => item.type === 'monitor_mcp')
    const dreamTasks = sorted.filter(item => item.type === 'dream')
    const scripts = sorted.filter(item => item.type === 'local_script')
    const teammates = sorted.filter(item => item.type === 'in_process_teammate')
    // Add leader entry when there are teammates, so users can foreground back to leader
    const leaderItem: TaskListItem[] =
      teammates.length > 0
        ? [
            {
              id: '__leader__',
              type: 'leader',
              label: `@${TEAM_LEAD_NAME}`,
              status: 'running',
            },
          ]
        : []
    const extras = scope !== 'terminal'
    const scheduled: StoppableItem[] = extras
      ? cronTasks.map(task => ({
          id: task.id,
          type: 'scheduled',
          label: task.prompt,
          status: 'running',
          when: scheduledTaskWhen(task),
        }))
      : []
    const goal: StoppableItem[] =
      extras && goalStatus.active
        ? [
            {
              id: GOAL_ITEM_ID,
              type: 'goal',
              label: goalStatus.prompt,
              status: 'running',
              when: 'active',
            },
          ]
        : []
    // An agent with a row above, or still running, is not history yet.
    const listed = new Set(allItems.map(item => item.id))
    const earlier = recordedAgents.filter(
      agent =>
        !listed.has(agent.agentId) &&
        typedTasks?.[agent.agentId]?.status !== 'running',
    )
    const history: HistoryItem[] = !extras
      ? []
      : historyOpen && earlier.length > 0
        ? earlier.map(entry => ({
            id: entry.agentId,
            type: 'recorded_agent',
            label: entry.description || entry.agentId,
            status: 'completed',
            entry,
          }))
        : [
            {
              id: SUBAGENT_HISTORY_ID,
              type: 'subagent_history',
              label: SUBAGENT_HISTORY_LABEL,
              status: 'running',
              size: earlier.length,
            },
          ]
    return {
      scheduledItems: scheduled,
      goalItems: goal,
      historyItems: history,
      bashTasks: bash,
      terminalTasks: terminals,
      remoteSessions: remote,
      agentTasks: agent,
      completedAgentTasks: completedAgents,
      mcpMonitors: monitorMcp,
      dreamTasks,
      scriptTasks: scripts,
      teammateTasks: [...leaderItem, ...teammates],
      // Order MUST match JSX render order (teammates \u2192 bash \u2192 interactive terminals \u2192 monitorMcp \u2192
      // remote \u2192 agent \u2192 completed \u2192 scheduled \u2192 goal \u2192 dream \u2192 scripts \u2192 history) so
      // \u2193/\u2191 navigation moves the cursor visually downward.
      allSelectableItems: [
        ...leaderItem,
        ...teammates,
        ...bash,
        ...terminals,
        ...monitorMcp,
        ...remote,
        ...agent,
        ...completedAgents,
        ...scheduled,
        ...goal,
        ...dreamTasks,
        ...scripts,
        ...history,
      ] as ListItem[],
    }
  }, [typedTasks, foregroundedTaskId, scope, cronTasks, goalStatus, recordedAgents, historyOpen])

  const currentSelection = allSelectableItems[selectedIndex] ?? null

  // Use configurable keybindings for standard navigation and confirm/cancel.
  // confirm:no is handled by Dialog's onCancel prop.
  useKeybindings(
    {
      'confirm:previous': () => setSelectedIndex(prev => Math.max(0, prev - 1)),
      'confirm:next': () =>
        setSelectedIndex(prev =>
          Math.min(allSelectableItems.length - 1, prev + 1),
        ),
      'confirm:yes': () => {
        const current = allSelectableItems[selectedIndex]
        if (current) {
          if (current.type === 'leader') {
            exitTeammateView(setAppState)
            onDone('Viewing leader', { display: 'system' })
          } else if (current.type === 'subagent_history') {
            if (current.size > 0) setHistoryOpen(true)
          } else if (current.type === 'recorded_agent') {
            openRecordedAgent(current.entry)
          } else if (current.type === 'local_agent' && isCompletedBackgroundAgent(current.task)) {
            enterTeammateView(current.id, setAppState)
            onDone('Viewing agent', { display: 'system' })
          } else if (
            current.type !== 'local_script' && // A script has no detail view; its row is all there is.
            current.type !== 'scheduled' &&
            current.type !== 'goal'
          ) {
            setViewState({ mode: 'detail', itemId: current.id })
          }
        }
      },
    },
    { context: 'Confirmation', isActive: viewState.mode === 'list' },
  )

  // Component-specific shortcuts (x=stop, f=foreground, right=zoom) shown in UI.
  // These are task-type and status dependent, not standard dialog keybindings.
  const handleKeyDown = (e: KeyboardEvent) => {
    // Only handle input when in list mode
    if (viewState.mode !== 'list') return

    if (e.key === 'left') {
      e.preventDefault()
      onDone('Background tasks dialog dismissed', { display: 'system' })
      return
    }

    // Compute current selection at the time of the key press
    const currentSelection = allSelectableItems[selectedIndex]
    if (!currentSelection) return // everything below requires a selection

    if (e.key === 'x') {
      e.preventDefault()
      if (currentSelection.type === 'scheduled' || currentSelection.type === 'goal') {
        setViewState({ mode: 'confirmStop', itemId: currentSelection.id })
      } else if (
        currentSelection.type === 'local_bash' &&
        currentSelection.status === 'running'
      ) {
        void killShellTask(currentSelection.id)
      } else if (
        currentSelection.type === 'interactive_terminal' &&
        currentSelection.status === 'running'
      ) {
        void killTerminalTask(currentSelection.id)
      } else if (
        currentSelection.type === 'local_agent' &&
        currentSelection.status === 'running'
      ) {
        killAgentTask(currentSelection.id)
      } else if (
        currentSelection.type === 'in_process_teammate' &&
        currentSelection.status === 'running'
      ) {
        void killTeammateTask(currentSelection.id)
      } else if (
        currentSelection.type === 'local_workflow' &&
        currentSelection.status === 'running' &&
        killWorkflowTask
      ) {
        killWorkflowTask(currentSelection.id, setAppState)
      } else if (
        currentSelection.type === 'monitor_mcp' &&
        currentSelection.status === 'running' &&
        killMonitorMcp
      ) {
        killMonitorMcp(currentSelection.id, setAppState)
      } else if (
        currentSelection.type === 'dream' &&
        currentSelection.status === 'running'
      ) {
        void killDreamTask(currentSelection.id)
      } else if (
        currentSelection.type === 'local_script' &&
        currentSelection.status === 'running'
      ) {
        stopScriptTask(currentSelection.id, setAppState)
      } else if (
        currentSelection.type === 'remote_agent' &&
        currentSelection.status === 'running'
      ) {
        if (currentSelection.task.isUltraplan) {
          void stopUltraplan(
            currentSelection.id,
            currentSelection.task.sessionId,
            setAppState,
          )
        } else {
          void killRemoteAgentTask(currentSelection.id)
        }
      }
    }

    if (e.key === 'f') {
      if (
        currentSelection?.type === 'in_process_teammate' && isViewableTeammate(currentSelection.task)
      ) {
        e.preventDefault()
        enterTeammateView(currentSelection.id, setAppState)
        onDone('Viewing teammate', { display: 'system' })
      } else if (currentSelection.type === 'leader') {
        e.preventDefault()
        exitTeammateView(setAppState)
        onDone('Viewing leader', { display: 'system' })
      }
    }
  }

  async function killShellTask(taskId: string): Promise<void> {
    await LocalShellTask.kill(taskId, setAppState)
  }

  async function killTerminalTask(taskId: string): Promise<void> {
    await TerminalTask.kill(taskId, setAppState)
  }

  function killAgentTask(taskId: string): void {
    killAsyncAgent(taskId, setAppState, 'user')
  }

  async function killTeammateTask(taskId: string): Promise<void> {
    await InProcessTeammateTask.kill(taskId, setAppState)
  }

  async function killDreamTask(taskId: string): Promise<void> {
    await DreamTask.kill(taskId, setAppState)
  }

  async function killRemoteAgentTask(taskId: string): Promise<void> {
    await RemoteAgentTask.kill(taskId, setAppState)
  }

  function stopItem(item: StoppableItem): void {
    const notice = (text: string) => createSystemMessage(text, 'notice')
    if (item.type === 'scheduled') {
      if (cronTasks.find(task => task.id === item.id)?.kind === 'loop') {
        cancelLoopWakeups()
      } else {
        removeSessionCronTasks([item.id])
      }
      setCronTasks(getSessionCronTasks())
      toolUseContext.setMessages?.(prev => [
        ...prev,
        notice(`Stopped scheduled task: ${truncate(item.label, 60, true)}`),
      ])
      return
    }
    const { clearedGoal, attachment } = clearGoal(setAppState, getSessionId())
    toolUseContext.setMessages?.(prev => [
      ...prev,
      notice(`Goal cleared: ${truncate(clearedGoal ?? item.label, 60, true)}`),
      ...(attachment ? [createAttachmentMessage(attachment)] : []),
    ])
  }

  // The agent left the task list; its transcript on disk is what reopens it.
  function openRecordedAgent(entry: RecordedSubagent): void {
    const { agentId, agentType } = entry
    if (agentType === undefined) {
      setUnopenable(prev => new Set(prev).add(agentId))
      return
    }
    setAppState(prev => {
      if (prev.tasks[agentId]) return prev
      const task: LocalAgentTaskState = {
        ...createTaskStateBase(agentId, 'local_agent', entry.description || agentId),
        type: 'local_agent',
        status: entry.stoppedByUser ? 'killed' : 'completed',
        ...(entry.stoppedByUser && { stoppedByUser: true }),
        ...(entry.startedAt !== undefined && { startTime: entry.startedAt }),
        endTime: entry.lastActivityAt,
        notified: true,
        agentId,
        prompt: '',
        agentType,
        spawnDepth: 0,
        retrieved: false,
        lastReportedToolCount: 0,
        lastReportedTokenCount: 0,
        isBackgrounded: true,
        isIdle: false,
        pendingMessages: [],
        retain: false,
        diskLoaded: false,
        keepaliveReasons: new Set(),
      }
      return { ...prev, tasks: { ...prev.tasks, [agentId]: task } }
    })
    enterTeammateView(agentId, setAppState)
    onDone('Viewing agent', { display: 'system' })
  }

  // Wrap onDone in useEffectEvent to get a stable reference that always calls
  // the current onDone callback without causing the effect to re-fire.
  const onDoneEvent = useEffectEvent(onDone)

  useEffect(() => {
    if (
      viewState.mode === 'confirmStop' &&
      !allSelectableItems.some(item => item.id === viewState.itemId)
    ) {
      setViewState({ mode: 'list' })
    }
    if (viewState.mode === 'detail') {
      const task = (typedTasks ?? {})[viewState.itemId]
      // Workflow tasks get a grace: their detail view stays open through
      // completion so the user sees the final state before eviction.
      if (
        !task ||
        (task.type !== 'local_workflow' && !isBackgroundTask(task) && !isViewableTeammate(task))
      ) {
        // Task was removed or is no longer a background task (e.g. killed).
        // If we skipped the list on mount, close the dialog entirely.
        if (skippedListOnMount.current) {
          onDoneEvent('Background tasks dialog dismissed', {
            display: 'system',
          })
        } else {
          setViewState({ mode: 'list' })
        }
      }
    }

    const totalItems = allSelectableItems.length
    if (selectedIndex >= totalItems && totalItems > 0) {
      setSelectedIndex(totalItems - 1)
    }
  }, [viewState, typedTasks, selectedIndex, allSelectableItems])

  // Helper to go back to list view (or close dialog if we skipped list on
  // mount AND there's still only ≤1 item). Checking current count prevents
  // the stale-state trap: if you opened with 1 task (auto-skipped to detail),
  // then a second task started, 'back' should show the list — not close.
  const goBackToList = () => {
    if (
      skippedListOnMount.current &&
      allSelectableItems.length - historyItems.length <= 1
    ) {
      onDone('Background tasks dialog dismissed', { display: 'system' })
    } else {
      skippedListOnMount.current = false
      setViewState({ mode: 'list' })
    }
  }

  if (viewState.mode === 'confirmStop') {
    const item = allSelectableItems.find(i => i.id === viewState.itemId)
    if (item?.type !== 'scheduled' && item?.type !== 'goal') return null
    const backToList = () => setViewState({ mode: 'list' })
    return (
      <Dialog title={STOP_TITLES[item.type]} onCancel={backToList} color="background">
        <Text>{item.label}</Text>
        <Select
          hideIndexes
          options={[
            { label: 'No, keep running', value: 'keep' as const },
            { label: 'Yes, stop', value: 'stop' as const },
          ]}
          onChange={value => {
            if (value === 'stop') stopItem(item)
            backToList()
          }}
        />
      </Dialog>
    )
  }

  // If an item is selected, show the appropriate view
  if (viewState.mode === 'detail' && typedTasks) {
    const task = typedTasks[viewState.itemId]
    if (!task) {
      return null
    }

    // Detail mode - show appropriate detail dialog
    switch (task.type) {
      case 'local_bash':
        return (
          <ShellDetailDialog
            shell={task}
            onDone={onDone}
            onKillShell={() => void killShellTask(task.id)}
            onBack={goBackToList}
            key={`shell-${task.id}`}
          />
        )
      case 'interactive_terminal':
        return (
          <TerminalDetailDialog task={task} onBack={goBackToList} />
        )
      case 'local_agent':
        return (
          <AsyncAgentDetailDialog
            agent={task}
            onDone={onDone}
            onKillAgent={() => killAgentTask(task.id)}
            onBack={goBackToList}
            key={`agent-${task.id}`}
          />
        )
      case 'remote_agent':
        return (
          <RemoteSessionDetailDialog
            session={task}
            onDone={onDone}
            toolUseContext={toolUseContext}
            onBack={goBackToList}
            onKill={
              task.status !== 'running'
                ? undefined
                : task.isUltraplan
                  ? () =>
                      void stopUltraplan(task.id, task.sessionId, setAppState)
                  : () => void killRemoteAgentTask(task.id)
            }
            key={`session-${task.id}`}
          />
        )
      case 'in_process_teammate':
        return (
          <InProcessTeammateDetailDialog
            teammate={task}
            onDone={onDone}
            onKill={
              task.status === 'running'
                ? () => void killTeammateTask(task.id)
                : undefined
            }
            onBack={goBackToList}
            onForeground={
              isViewableTeammate(task)
                ? () => {
                    enterTeammateView(task.id, setAppState)
                    onDone('Viewing teammate', { display: 'system' })
                  }
                : undefined
            }
            key={`teammate-${task.id}`}
          />
        )
      case 'local_workflow':
        if (!WorkflowDetailDialog) return null
        return (
          <WorkflowDetailDialog
            workflow={task}
            onKill={
              task.status === 'running' && killWorkflowTask
                ? () => killWorkflowTask(task.id, setAppState)
                : undefined
            }
            onSkipAgent={
              task.status === 'running' && skipWorkflowAgent
                ? agentId => skipWorkflowAgent(task.id, agentId, setAppState)
                : undefined
            }
            onRetryAgent={
              task.status === 'running' && retryWorkflowAgent
                ? agentId => retryWorkflowAgent(task.id, agentId, setAppState)
                : undefined
            }
            onPause={
              task.status === 'running' && pauseWorkflowTask
                ? () => pauseWorkflowTask(task.id, setAppState)
                : undefined
            }
            onBack={goBackToList}
            onSaved={message => onDone(message, { display: 'system' })}
            key={`workflow-${task.id}`}
          />
        )
      case 'monitor_mcp':
        if (!MonitorMcpDetailDialog) return null
        return (
          <MonitorMcpDetailDialog
            task={task}
            onKill={
              task.status === 'running' && killMonitorMcp
                ? () => killMonitorMcp(task.id, setAppState)
                : undefined
            }
            onBack={goBackToList}
            key={`monitor-mcp-${task.id}`}
          />
        )
      case 'dream':
        return (
          <DreamDetailDialog
            task={task}
            onDone={() =>
              onDone('Background tasks dialog dismissed', {
                display: 'system',
              })
            }
            onBack={goBackToList}
            onKill={
              task.status === 'running'
                ? () => void killDreamTask(task.id)
                : undefined
            }
            key={`dream-${task.id}`}
          />
        )
    }
  }

  const runningBashCount = count(bashTasks, _ => _.status === 'running')
  const runningTerminalCount = count(
    terminalTasks,
    _ => _.status === 'running',
  )
  const runningAgentCount =
    count(
      remoteSessions,
      _ => _.status === 'running' || _.status === 'pending',
    ) + count(agentTasks, _ => _.status === 'running')
  const runningTeammateCount = count(
    teammateTasks,
    _ => _.type !== 'leader' && _.status === 'running',
  )
  const subtitle = intersperse(
    [
      ...(runningTeammateCount > 0
        ? [
            <Text key="teammates">
              {runningTeammateCount}{' '}
              {runningTeammateCount !== 1 ? 'agents' : 'agent'}
            </Text>,
          ]
        : []),
      ...(runningBashCount > 0
        ? [
            <Text key="shells">
              {runningBashCount}{' '}
              {runningBashCount !== 1 ? 'active shells' : 'active shell'}
            </Text>,
          ]
        : []),
      ...(runningTerminalCount > 0
        ? [
            <Text key="terminals">
              {runningTerminalCount}{' '}
              {runningTerminalCount !== 1 ? 'terminals' : 'terminal'}
            </Text>,
          ]
        : []),
      ...(runningAgentCount > 0
        ? [
            <Text key="agents">
              {runningAgentCount}{' '}
              {runningAgentCount !== 1 ? 'active agents' : 'active agent'}
            </Text>,
          ]
        : []),
      ...(scheduledItems.length > 0
        ? [
            <Text key="scheduled">
              {scheduledItems.length}{' '}
              {scheduledItems.length !== 1 ? 'scheduled tasks' : 'scheduled task'}
            </Text>,
          ]
        : []),
    ],
    index => <Text key={`separator-${index}`}> · </Text>,
  )

  const actions = [
    ...(allSelectableItems.length > 1
      ? [<KeyboardShortcutHint key="upDown" shortcut="↑/↓" action="select" />]
      : []),
    ...(currentSelection?.type === 'subagent_history'
      ? currentSelection.size > 0
        ? [<KeyboardShortcutHint key="enter" shortcut="Enter" action="show" />]
        : []
      : currentSelection?.type !== 'local_script' &&
          currentSelection?.type !== 'scheduled' &&
          currentSelection?.type !== 'goal'
        ? [<KeyboardShortcutHint key="enter" shortcut="Enter" action="view" />]
        : []),
    ...(currentSelection?.type === 'in_process_teammate' && isViewableTeammate(currentSelection.task)
      ? [
          <KeyboardShortcutHint
            key="foreground"
            shortcut="f"
            action="foreground"
          />,
        ]
      : []),
    ...((currentSelection?.type === 'local_bash' ||
      currentSelection?.type === 'interactive_terminal' ||
      currentSelection?.type === 'local_agent' ||
      currentSelection?.type === 'in_process_teammate' ||
      currentSelection?.type === 'local_workflow' ||
      currentSelection?.type === 'monitor_mcp' ||
      currentSelection?.type === 'dream' ||
      currentSelection?.type === 'local_script' ||
      currentSelection?.type === 'scheduled' ||
      currentSelection?.type === 'goal' ||
      currentSelection?.type === 'remote_agent') &&
    currentSelection.status === 'running'
      ? [<KeyboardShortcutHint key="kill" shortcut="x" action="stop" />]
      : []),
    ...(agentTasks.some(t => t.status === 'running')
      ? [
          <KeyboardShortcutHint
            key="kill-all"
            shortcut={killAgentsShortcut}
            action="stop all agents"
          />,
        ]
      : []),
    <KeyboardShortcutHint key="esc" shortcut="Esc" action="close" />,
  ]

  const handleCancel = () =>
    onDone('Background tasks dialog dismissed', { display: 'system' })

  function renderInputGuide(exitState: ExitState): React.ReactNode {
    if (exitState.pending) {
      return <Text>Press {exitState.keyName} again to exit</Text>
    }
    return <Byline>{actions}</Byline>
  }

  return (
    <Box
      flexDirection="column"
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
    >
      <Dialog
        title="Background"
        subtitle={<>{subtitle}</>}
        onCancel={handleCancel}
        color="background"
        inputGuide={renderInputGuide}
      >
        {allSelectableItems.length === historyItems.length ? (
          <Box flexDirection="column">
            <Text dimColor>
              {scope === 'terminal'
                ? 'No terminals currently running'
                : 'No tasks currently running'}
            </Text>
            <HistoryRows
              items={historyItems}
              currentSelectionId={currentSelection?.id}
              unopenable={unopenable}
            />
          </Box>
        ) : (
          <Box flexDirection="column">
            {teammateTasks.length > 0 && (
              <Box flexDirection="column">
                {(bashTasks.length > 0 ||
                  remoteSessions.length > 0 ||
                  agentTasks.length > 0 ||
                  completedAgentTasks.length > 0) && (
                  <Text dimColor>
                    <Text bold>{'  '}Agents</Text> (
                    {count(teammateTasks, i => i.type !== 'leader')})
                  </Text>
                )}
                <Box flexDirection="column">
                  <TeammateTaskGroups
                    teammateTasks={teammateTasks}
                    currentSelectionId={currentSelection?.id}
                  />
                </Box>
              </Box>
            )}

            {bashTasks.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={teammateTasks.length > 0 ? 1 : 0}
              >
                {(teammateTasks.length > 0 ||
                  remoteSessions.length > 0 ||
                  agentTasks.length > 0 ||
                  completedAgentTasks.length > 0) && (
                  <Text dimColor>
                    <Text bold>{'  '}Shells</Text> ({bashTasks.length})
                  </Text>
                )}
                <Box flexDirection="column">
                  {bashTasks.map(item => (
                    <Item
                      key={item.id}
                      item={item}
                      isSelected={item.id === currentSelection?.id}
                    />
                  ))}
                </Box>
              </Box>
            )}

            {terminalTasks.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={
                  teammateTasks.length > 0 || bashTasks.length > 0 ? 1 : 0
                }
              >
                <Text dimColor>
                  <Text bold>{'  '}Terminals</Text> ({terminalTasks.length})
                </Text>
                <Box flexDirection="column">
                  {terminalTasks.map(item => (
                    <Item
                      key={item.id}
                      item={item}
                      isSelected={item.id === currentSelection?.id}
                    />
                  ))}
                </Box>
              </Box>
            )}

            {mcpMonitors.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={
                  teammateTasks.length > 0 || bashTasks.length > 0 || terminalTasks.length > 0 ? 1 : 0
                }
              >
                <Text dimColor>
                  <Text bold>{'  '}Monitors</Text> ({mcpMonitors.length})
                </Text>
                <Box flexDirection="column">
                  {mcpMonitors.map(item => (
                    <Item
                      key={item.id}
                      item={item}
                      isSelected={item.id === currentSelection?.id}
                    />
                  ))}
                </Box>
              </Box>
            )}

            {remoteSessions.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={
                  teammateTasks.length > 0 ||
                  bashTasks.length > 0 ||
                  mcpMonitors.length > 0
                    ? 1
                    : 0
                }
              >
                <Text dimColor>
                  <Text bold>{'  '}Remote agents</Text> ({remoteSessions.length}
                  )
                </Text>
                <Box flexDirection="column">
                  {remoteSessions.map(item => (
                    <Item
                      key={item.id}
                      item={item}
                      isSelected={item.id === currentSelection?.id}
                    />
                  ))}
                </Box>
              </Box>
            )}

            {agentTasks.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={
                  teammateTasks.length > 0 ||
                  bashTasks.length > 0 ||
                  mcpMonitors.length > 0 ||
                  remoteSessions.length > 0
                    ? 1
                    : 0
                }
              >
                <Text dimColor>
                  <Text bold>{'  '}Local agents</Text> ({agentTasks.length})
                </Text>
                <Box flexDirection="column">
                  {agentTasks.map(item => (
                    <Item
                      key={item.id}
                      item={item}
                      isSelected={item.id === currentSelection?.id}
                    />
                  ))}
                </Box>
              </Box>
            )}

            {completedAgentTasks.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={
                  teammateTasks.length > 0 ||
                  bashTasks.length > 0 ||
                  mcpMonitors.length > 0 ||
                  remoteSessions.length > 0 ||
                  agentTasks.length > 0
                    ? 1
                    : 0
                }
              >
                <Text dimColor>
                  <Text bold>{'  '}Completed</Text> ({completedAgentTasks.length})
                </Text>
                <Box flexDirection="column">
                  {completedAgentTasks.map(item => (
                    <Item
                      key={item.id}
                      item={item}
                      isSelected={item.id === currentSelection?.id}
                    />
                  ))}
                </Box>
              </Box>
            )}

            {[
              { heading: 'Scheduled', items: scheduledItems },
              { heading: 'Goal', items: goalItems },
            ].map(
              ({ heading, items }) =>
                items.length > 0 && (
                  <Box
                    key={heading}
                    flexDirection="column"
                    marginTop={allSelectableItems[0] === items[0] ? 0 : 1}
                  >
                    <Text dimColor bold>
                      {'  '}
                      {heading}
                    </Text>
                    <StoppableRows
                      items={items}
                      currentSelectionId={currentSelection?.id}
                    />
                  </Box>
                ),
            )}

            {dreamTasks.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={
                  teammateTasks.length > 0 ||
                  bashTasks.length > 0 ||
                  mcpMonitors.length > 0 ||
                  remoteSessions.length > 0 ||
                  agentTasks.length > 0 ||
                  completedAgentTasks.length > 0
                    ? 1
                    : 0
                }
              >
                <Box flexDirection="column">
                  {dreamTasks.map(item => (
                    <Item
                      key={item.id}
                      item={item}
                      isSelected={item.id === currentSelection?.id}
                    />
                  ))}
                </Box>
              </Box>
            )}

            {/* Official 2.1.325: Code Mode scripts, after the dream, with no heading. */}
            {scriptTasks.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={allSelectableItems.length > scriptTasks.length ? 1 : 0}
              >
                {scriptTasks.map(item => (
                  <Item
                    key={item.id}
                    item={item}
                    isSelected={item.id === currentSelection?.id}
                  />
                ))}
              </Box>
            )}

            {historyItems.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <HistoryRows
                  items={historyItems}
                  currentSelectionId={currentSelection?.id}
                  unopenable={unopenable}
                />
              </Box>
            )}
          </Box>
        )}
      </Dialog>
    </Box>
  )
}

function toListItem(task: BackgroundTaskState): TaskListItem {
  switch (task.type) {
    case 'local_bash':
      return {
        id: task.id,
        type: 'local_bash',
        label: task.kind === 'monitor' ? task.description : task.command,
        status: task.status,
        task,
      }
    case 'interactive_terminal':
      return {
        id: task.id,
        type: 'interactive_terminal',
        label: task.description,
        status: task.status,
        task,
      }
    case 'remote_agent':
      return {
        id: task.id,
        type: 'remote_agent',
        label: task.title,
        status: task.status,
        task,
      }
    case 'local_agent':
      return {
        id: task.id,
        type: 'local_agent',
        label: task.description,
        status: task.status,
        task,
      }
    case 'in_process_teammate':
      return {
        id: task.id,
        type: 'in_process_teammate',
        label: `@${task.identity.agentName}`,
        status: task.status,
        task,
      }
    case 'local_workflow':
      return {
        id: task.id,
        type: 'local_workflow',
        label: task.summary ?? task.description,
        status: task.status,
        task,
      }
    case 'monitor_mcp':
      return {
        id: task.id,
        type: 'monitor_mcp',
        label: task.description,
        status: task.status,
        task,
      }
    case 'dream':
      return {
        id: task.id,
        type: 'dream',
        label: task.description,
        status: task.status,
        task,
      }
    case 'local_script':
      return {
        id: task.id,
        type: 'local_script',
        label: task.description,
        status: task.status,
        task,
      }
  }
}

function scheduledTaskWhen(task: SessionCronTask): string {
  if (task.recurring) return cronToHuman(task.cron)
  const at = task.scheduledFor ?? nextCronRunMs(task.cron, task.createdAt)
  if (at === null) return cronToHuman(task.cron)
  return `Runs once in ${formatDuration(Math.max(0, at - Date.now()), { mostSignificantOnly: true })}`
}

function recordedAgentMeta(entry: RecordedSubagent, isUnopenable: boolean): string {
  const ago = (ms: number | undefined) =>
    ms === undefined ? '' : formatRelativeTimeAgo(new Date(ms))
  const started = ago(entry.startedAt)
  const lastActive = ago(entry.lastActivityAt)
  return [
    isUnopenable && 'cannot be opened',
    entry.stoppedByUser && 'stopped',
    entry.name ? `@${entry.name}` : entry.agentType,
    started && `started ${started}`,
    lastActive && lastActive !== started && `last active ${lastActive}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function Row({
  isSelected,
  icon,
  label,
  labelWidth,
  meta,
}: {
  isSelected: boolean
  icon?: string
  label: string
  labelWidth: number
  meta?: string
}): ReactNode {
  const useGreyPointer = isCoordinatorMode()
  return (
    <Box flexDirection="row">
      <Text dimColor={useGreyPointer && isSelected}>
        {isSelected ? figures.pointer + ' ' : '  '}
      </Text>
      {icon && <Text dimColor>{icon} </Text>}
      <Box width={meta ? labelWidth + 3 : undefined} flexShrink={0}>
        <Text color={isSelected && !useGreyPointer ? 'suggestion' : undefined} wrap="truncate-end">
          {label}
        </Text>
      </Box>
      {meta && (
        <Text dimColor wrap="truncate-end">
          {meta}
        </Text>
      )}
    </Box>
  )
}

function StoppableRows({
  items,
  currentSelectionId,
}: {
  items: StoppableItem[]
  currentSelectionId: string | undefined
}): ReactNode {
  const labelWidth = Math.max(...items.map(item => stringWidth(item.label)))
  return (
    <Box flexDirection="column">
      {items.map(item => (
        <Row
          key={item.id}
          isSelected={item.id === currentSelectionId}
          icon={figures.circle}
          label={item.label}
          labelWidth={labelWidth}
          meta={item.when}
        />
      ))}
    </Box>
  )
}

function HistoryRows({
  items,
  currentSelectionId,
  unopenable,
}: {
  items: HistoryItem[]
  currentSelectionId: string | undefined
  unopenable: ReadonlySet<string>
}): ReactNode {
  const labelWidth = Math.max(0, ...items.map(item => stringWidth(item.label)))
  const isExpanded = items[0]?.type === 'recorded_agent'
  return (
    <Box flexDirection="column">
      {isExpanded && (
        <Text dimColor bold>
          {'  '}
          {SUBAGENT_HISTORY_LABEL} ({items.length})
        </Text>
      )}
      {items.map(item =>
        item.type === 'recorded_agent' ? (
          <Row
            key={item.id}
            isSelected={item.id === currentSelectionId}
            label={item.label}
            labelWidth={labelWidth}
            meta={recordedAgentMeta(item.entry, unopenable.has(item.id))}
          />
        ) : (
          <Row
            key={item.id}
            isSelected={item.id === currentSelectionId}
            label={`${item.label} (${item.size})`}
            labelWidth={labelWidth}
          />
        ),
      )}
    </Box>
  )
}

function Item({
  item,
  isSelected,
}: {
  item: TaskListItem
  isSelected: boolean
}): ReactNode {
  const { columns } = useTerminalSize()
  // Dialog border (2) + padding (2) + pointer prefix (2) + name/status overhead (~20)
  const maxActivityWidth = Math.max(30, columns - 26)
  // In coordinator mode, use grey pointer instead of blue
  const useGreyPointer = isCoordinatorMode()

  return (
    <Box flexDirection="row">
      <Text dimColor={useGreyPointer && isSelected}>
        {isSelected ? figures.pointer + ' ' : '  '}
      </Text>
      <Text color={isSelected && !useGreyPointer ? 'suggestion' : undefined}>
        {item.type === 'leader' ? (
          <Text>@{TEAM_LEAD_NAME}</Text>
        ) : (
          <BackgroundTaskComponent
            task={item.task}
            maxActivityWidth={maxActivityWidth}
          />
        )}
      </Text>
    </Box>
  )
}

function TeammateTaskGroups({
  teammateTasks,
  currentSelectionId,
}: {
  teammateTasks: TaskListItem[]
  currentSelectionId: string | undefined
}): ReactNode {
  // Separate leader from teammates, group teammates by team
  const leaderItems = teammateTasks.filter(i => i.type === 'leader')
  const teammateItems = teammateTasks.filter(
    i => i.type === 'in_process_teammate',
  )
  const teams = new Map<string, typeof teammateItems>()
  for (const item of teammateItems) {
    const teamName = item.task.identity.teamName
    const group = teams.get(teamName)
    if (group) {
      group.push(item)
    } else {
      teams.set(teamName, [item])
    }
  }
  const teamEntries = [...teams.entries()]
  return (
    <>
      {teamEntries.map(([teamName, items]) => {
        const memberCount = items.length + leaderItems.length
        return (
          <Box key={teamName} flexDirection="column">
            <Text dimColor>
              {'  '}Team: {teamName} ({memberCount})
            </Text>
            {/* Render leader first within each team */}
            {leaderItems.map(item => (
              <Item
                key={`${item.id}-${teamName}`}
                item={item}
                isSelected={item.id === currentSelectionId}
              />
            ))}
            {items.map(item => (
              <Item
                key={item.id}
                item={item}
                isSelected={item.id === currentSelectionId}
              />
            ))}
          </Box>
        )
      })}
    </>
  )
}
