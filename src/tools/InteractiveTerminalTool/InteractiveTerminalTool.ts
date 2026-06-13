import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import { createBunPtyDriver } from '../../utils/pty/bunPtyDriver.js'
import { PtySessionManager } from '../../utils/pty/PtySessionManager.js'
import type { InteractiveTerminalTaskState } from '../../tasks/InteractiveTerminalTask.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import {
  actionSchema,
  closeActionSchema,
  listActionSchema,
  openActionSchema,
  readActionSchema,
  resizeActionSchema,
  sendKeyActionSchema,
  signalActionSchema,
  statusActionSchema,
  writeActionSchema,
} from './actionSchemas.js'
import { handleClose } from './handlers/close.js'
import { handleList } from './handlers/list.js'
import { handleOpen } from './handlers/open.js'
import { handleRead } from './handlers/read.js'
import { handleResize } from './handlers/resize.js'
import { handleSendKey } from './handlers/sendKey.js'
import { handleSignal } from './handlers/signal.js'
import { handleStatus } from './handlers/status.js'
import { handleWrite } from './handlers/write.js'
import {
  DESCRIPTION,
  INTERACTIVE_TERMINAL_TOOL_NAME,
  PROMPT,
} from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'
import { syncInteractiveTerminalTaskAfterStatus } from './taskState.js'

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
    maxBufferedChunks: 200,
  })
  return terminalManagerInstance
}

export const terminalTaskRegistry = new Map<string, string>()

function updateTerminalTask(
  sessionId: string,
  setAppState: Parameters<typeof updateTaskState>[1],
  updater: (task: InteractiveTerminalTaskState) => InteractiveTerminalTaskState,
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
  updateTerminalTask(sessionId, setAppState, task => ({
    ...task,
    cols: status.cols,
    rows: status.rows,
    preview: manager.getRenderedPreview(sessionId),
    closed: status.state !== 'running',
  }))
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
        details: { sessionId: message.replace('Unknown PTY session: ', '') },
      },
    }
  }

  if (message.startsWith('SESSION_ALREADY_CLOSED:')) {
    return {
      error: {
        code: 'SESSION_ALREADY_CLOSED',
        message,
        details: { sessionId: message.split(': ')[1] },
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

export const InteractiveTerminalTool: Tool<InputSchema, Output> = buildTool({
  name: INTERACTIVE_TERMINAL_TOOL_NAME,
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
    return INTERACTIVE_TERMINAL_TOOL_NAME
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly(input) {
    return input.action === 'read' || input.action === 'status' || input.action === 'list'
  },
  toAutoClassifierInput(input) {
    return `${input.action} ${'sessionId' in input ? String(input.sessionId ?? '') : ''}`.trim()
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
        case 'open': {
          const parsed = openActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=open requires a valid open payload', {
                action: 'open',
              }),
            }
          }
          const permission = await canUseTool(
            InteractiveTerminalTool,
            parsed.data,
            context,
            assistantMessage,
            context.toolUseId ?? 'interactive-terminal-open',
          )
          if (permission.behavior !== 'allow') {
            return {
              data: {
                error: {
                  code: 'PERMISSION_DENIED',
                  message: 'Interactive terminal session creation was denied',
                  details: { action: 'open' },
                },
              },
            }
          }
          const opened = await handleOpen(getTerminalManager(), parsed.data)
          const taskId = generateTaskId('interactive_terminal')
          terminalTaskRegistry.set(String(opened.sessionId), taskId)
          registerTask(
            {
              ...createTaskStateBase(
                taskId,
                'interactive_terminal',
                `Interactive terminal ${opened.sessionId}`,
                context.toolUseId,
              ),
              type: 'interactive_terminal',
              status: 'running',
              sessionId: String(opened.sessionId),
              command: String(opened.command),
              cwd: parsed.data.cwd || process.cwd(),
              cols: opened.cols,
              rows: opened.rows,
              preview: String(opened.preview ?? ''),
              closed: false,
            },
            context.setAppState,
          )
          return { data: opened }
        }
        case 'write': {
          const parsed = writeActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=write requires sessionId and text', {
                action: 'write',
              }),
            }
          }
          const manager = getTerminalManager()
          const written = handleWrite(manager, parsed.data)
          refreshTerminalTaskPreview(parsed.data.sessionId, context.setAppState, manager)
          return { data: written }
        }
        case 'read': {
          const parsed = readActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=read requires sessionId', { action: 'read' }),
            }
          }
          const manager = getTerminalManager()
          const read = handleRead(manager, parsed.data)
          refreshTerminalTaskPreview(parsed.data.sessionId, context.setAppState, manager)
          return { data: read }
        }
        case 'list': {
          const parsed = listActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=list requires no additional payload', { action: 'list' }),
            }
          }
          return { data: handleList(getTerminalManager()) }
        }
        case 'send_key': {
          const parsed = sendKeyActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=send_key requires sessionId and key', {
                action: 'send_key',
              }),
            }
          }
          const keyResult = handleSendKey(getTerminalManager(), parsed.data)
          return { data: keyResult }
        }
        case 'resize': {
          const parsed = resizeActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=resize requires sessionId, cols and rows', {
                action: 'resize',
              }),
            }
          }
          const manager = getTerminalManager()
          const resized = handleResize(manager, parsed.data)
          refreshTerminalTaskPreview(parsed.data.sessionId, context.setAppState, manager)
          return { data: resized }
        }
        case 'signal': {
          const parsed = signalActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=signal requires sessionId and signal', {
                action: 'signal',
              }),
            }
          }
          const manager = getTerminalManager()
          const signalResult = handleSignal(manager, parsed.data)
          refreshTerminalTaskPreview(parsed.data.sessionId, context.setAppState, manager)
          return { data: signalResult }
        }
        case 'status': {
          const parsed = statusActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=status requires sessionId', { action: 'status' }),
            }
          }
          const manager = getTerminalManager()
          const status = handleStatus(manager, parsed.data)
          updateTerminalTask(parsed.data.sessionId, context.setAppState, task =>
            syncInteractiveTerminalTaskAfterStatus(task, {
              isRunning: status.isRunning,
              cols: status.cols,
              rows: status.rows,
              preview: manager.getRenderedPreview(parsed.data.sessionId),
            }),
          )
          return { data: status }
        }
        case 'close': {
          const parsed = closeActionSchema.safeParse(input)
          if (!parsed.success) {
            return {
              data: invalidInput('action=close requires sessionId', { action: 'close' }),
            }
          }
          const manager = getTerminalManager()
          const closed = handleClose(manager, parsed.data)
          updateTerminalTask(parsed.data.sessionId, context.setAppState, task => ({
            ...task,
            preview: manager.getRenderedPreview(parsed.data.sessionId),
            status: 'completed',
            closed: true,
            endTime: Date.now(),
          }))
          terminalTaskRegistry.delete(parsed.data.sessionId)
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
