import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import { registerTerminalTaskRuntimeKiller } from '../../tasks/TerminalTask.js'
import { createBunPtyDriver } from '../../utils/pty/bunPtyDriver.js'
import { PtySessionManager } from '../../utils/pty/PtySessionManager.js'
import type { TerminalTaskState } from '../../tasks/TerminalTask.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import {
  actionSchema,
  capturePaneActionSchema,
  displayMessageActionSchema,
  killPaneActionSchema,
  listPanesActionSchema,
  newSessionActionSchema,
  resizePaneActionSchema,
  sendKeysActionSchema,
  sendSignalActionSchema,
} from './actionSchemas.js'
import { handleClose } from './handlers/close.js'
import { handleList } from './handlers/list.js'
import { handleOpen } from './handlers/open.js'
import { handleRead } from './handlers/read.js'
import { handleResize } from './handlers/resize.js'
import { handleSignal } from './handlers/signal.js'
import { handleStatus } from './handlers/status.js'
import { handleWrite } from './handlers/write.js'
import {
  DESCRIPTION,
  PROMPT,
  TERMINAL_TOOL_NAME,
} from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'
import { syncTerminalTaskAfterStatus } from './taskState.js'
import { DEFAULT_MAX_BUFFERED_CHUNKS } from '../../utils/pty/types.js'

const inputSchema = lazySchema(() => actionSchema)
type InputSchema = ReturnType<typeof inputSchema>

type SuccessOutput = Record<string, unknown>
type ErrorOutput = {
  error: {
    code: string
    message: string
    details: Record<string, unknown>
  }
}

type Output = SuccessOutput | ErrorOutput

let terminalManagerInstance: PtySessionManager | undefined

export function getTerminalManager(): PtySessionManager {
  terminalManagerInstance ??= new PtySessionManager({
    driver: createBunPtyDriver(),
    maxBufferedChunks: DEFAULT_MAX_BUFFERED_CHUNKS,
  })
  return terminalManagerInstance
}

export function resetTerminalManagerForTesting(manager?: PtySessionManager): void {
  terminalManagerInstance = manager
  terminalTaskRegistry.clear()
}

export const terminalTaskRegistry = new Map<string, string>()

registerTerminalTaskRuntimeKiller((task, setAppState) => {
  const manager = getTerminalManager()
  let status
  try {
    status = manager.signal(task.sessionId, 'SIGTERM')
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('SESSION_ALREADY_CLOSED:'))) {
      throw error
    }
    status = manager.status(task.sessionId)
  }
  const preview = manager.getRenderedPreview(task.sessionId)
  terminalTaskRegistry.delete(task.sessionId)
  setAppState(prev => ({
    ...prev,
    tasks: {
      ...prev.tasks,
      [task.id]: {
        ...task,
        cols: status.cols,
        rows: status.rows,
        preview,
        status: 'killed',
        closed: true,
        endTime: Date.now(),
      },
    },
  }))
})

function updateTerminalTask(
  sessionId: string,
  setAppState: Parameters<typeof updateTaskState>[1],
  updater: (task: TerminalTaskState) => TerminalTaskState,
): void {
  const taskId = terminalTaskRegistry.get(sessionId)
  if (!taskId) {
    return
  }
  updateTaskState(taskId, setAppState, updater)
}

function refreshTerminalTaskPreview(
  sessionId: string,
  setAppState: Parameters<typeof updateTaskState>[1],
  manager: PtySessionManager,
): void {
  const status = manager.status(sessionId)
  const preview = manager.getRenderedPreview(sessionId)
  updateTerminalTask(sessionId, setAppState, task =>
    syncTerminalTaskAfterStatus(task, {
      isRunning: status.state === 'running',
      cols: status.cols,
      rows: status.rows,
      preview,
    }),
  )
}

function invalidInput(message: string, details: Record<string, unknown>): ErrorOutput {
  return {
    error: {
      code: 'INVALID_ACTION_INPUT',
      message,
      details,
    },
  }
}

function invalidAction(action: unknown): ErrorOutput {
  return {
    error: {
      code: 'INVALID_ACTION',
      message: `Unsupported action: ${String(action)}`,
      details: { action },
    },
  }
}

function formatError(error: unknown): ErrorOutput {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('Unknown PTY session: ')) {
    return {
      error: {
        code: 'SESSION_NOT_FOUND',
        message,
        details: { target: message.replace('Unknown PTY session: ', '') },
      },
    }
  }

  if (message.startsWith('SESSION_ALREADY_CLOSED:')) {
    return {
      error: {
        code: 'SESSION_ALREADY_CLOSED',
        message,
        details: { target: message.split(': ')[1] },
      },
    }
  }

  return {
    error: {
      code: 'INTERNAL_ERROR',
      message,
      details: {},
    },
  }
}

export const TerminalTool: Tool<InputSchema, Output> = buildTool({
  name: TERMINAL_TOOL_NAME,
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  userFacingName() {
    return TERMINAL_TOOL_NAME
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly(input) {
    return input.action === 'capture-pane' || input.action === 'display-message' || input.action === 'list-panes'
  },
  toAutoClassifierInput(input) {
    const parts = [String(input.action)]
    if ('target' in input && input.target) {
      parts.push(String(input.target))
    }
    if (input.action === 'new-session') {
      parts.push(`command=${input.command ?? '<default-shell>'}`)
      if (input.args) {
        parts.push(`args=${JSON.stringify(input.args)}`)
      }
    }
    return parts.join(' ')
  },
  renderToolUseMessage,
  renderToolUseProgressMessage() {
    return null
  },
  renderToolUseQueuedMessage() {
    return null
  },
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage() {
    return null
  },
  renderToolResultMessage,
  async call(input, context, canUseTool, assistantMessage, _onProgress) {
    try {
      switch (input.action) {
        case 'new-session': {
          const parsed = newSessionActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=new-session requires a valid session payload', {
                action: 'new-session',
              }),
            }
          }
          const permission = await canUseTool(
            TerminalTool,
            parsed.data,
            context,
            assistantMessage,
            context.toolUseId ?? 'terminal-new-session',
          )
          if (permission.behavior !== 'allow') {
            return {
              data: {
                error: {
                  code: 'PERMISSION_DENIED',
                  message: 'Terminal session creation was denied',
                  details: { action: 'new-session' },
                },
              },
            }
          }
          const opened = await handleOpen(getTerminalManager(), parsed.data)
          const target = String(opened.sessionId)
          const taskId = generateTaskId('interactive_terminal')
          terminalTaskRegistry.set(target, taskId)
          registerTask(
            {
              ...createTaskStateBase(
                taskId,
                'interactive_terminal',
                `Terminal ${target}`,
                context.toolUseId,
              ),
              type: 'interactive_terminal',
              status: 'running',
              sessionId: target,
              command: String(opened.command),
              cwd: parsed.data.cwd || process.cwd(),
              cols: opened.cols,
              rows: opened.rows,
              preview: String(opened.preview ?? ''),
              closed: false,
            },
            context.setAppState,
          )
          const { sessionId: _sessionId, ...openedOutput } = opened
          return { data: { ...openedOutput, target } }
        }
        case 'send-keys': {
          const parsed = sendKeysActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=send-keys requires target and text or key', {
                action: 'send-keys',
              }),
            }
          }
          const manager = getTerminalManager()
          const written = handleWrite(manager, parsed.data)
          refreshTerminalTaskPreview(parsed.data.target, context.setAppState, manager)
          return { data: written }
        }
        case 'capture-pane': {
          const parsed = capturePaneActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=capture-pane requires target', { action: 'capture-pane' }),
            }
          }
          const manager = getTerminalManager()
          const read = handleRead(manager, parsed.data)
          refreshTerminalTaskPreview(parsed.data.target, context.setAppState, manager)
          return { data: read }
        }
        case 'list-panes': {
          const parsed = listPanesActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=list-panes requires no additional payload', { action: 'list-panes' }),
            }
          }
          return { data: handleList(getTerminalManager()) }
        }
        case 'resize-pane': {
          const parsed = resizePaneActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=resize-pane requires target, cols and rows', {
                action: 'resize-pane',
              }),
            }
          }
          const manager = getTerminalManager()
          const resized = handleResize(manager, parsed.data)
          refreshTerminalTaskPreview(parsed.data.target, context.setAppState, manager)
          return { data: resized }
        }
        case 'send-signal': {
          const parsed = sendSignalActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=send-signal requires target and signal', {
                action: 'send-signal',
              }),
            }
          }
          const manager = getTerminalManager()
          const signalResult = handleSignal(manager, parsed.data)
          refreshTerminalTaskPreview(parsed.data.target, context.setAppState, manager)
          return { data: signalResult }
        }
        case 'display-message': {
          const parsed = displayMessageActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=display-message requires target', { action: 'display-message' }),
            }
          }
          const manager = getTerminalManager()
          const status = handleStatus(manager, parsed.data)
          const preview = manager.getRenderedPreview(parsed.data.target)
          updateTerminalTask(parsed.data.target, context.setAppState, task =>
            syncTerminalTaskAfterStatus(task, {
              isRunning: status.isRunning,
              cols: status.cols,
              rows: status.rows,
              preview,
            }),
          )
          return { data: status }
        }
        case 'kill-pane': {
          const parsed = killPaneActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=kill-pane requires target', { action: 'kill-pane' }),
            }
          }
          const manager = getTerminalManager()
          const closed = handleClose(manager, parsed.data)
          const preview = manager.getRenderedPreview(parsed.data.target)
          updateTerminalTask(parsed.data.target, context.setAppState, task => ({
            ...task,
            preview,
            status: 'completed',
            closed: true,
            endTime: Date.now(),
          }))
          terminalTaskRegistry.delete(parsed.data.target)
          return { data: closed }
        }
        default:
          return { data: invalidAction((input as { action?: unknown }).action) }
      }
    } catch (error) {
      return { data: formatError(error) }
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: 'tool_result',
      content: JSON.stringify(content),
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
