import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import {
  enqueueTerminalTaskNotification,
  registerTerminalTaskRuntimeKiller,
} from '../../tasks/TerminalTask.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { createBunPtyDriver } from '../../utils/pty/bunPtyDriver.js'
import { PtySessionManager } from '../../utils/pty/PtySessionManager.js'
import type {
  TerminalTaskState,
  TerminalTerminationReason,
} from '../../tasks/TerminalTask.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import {
  appendTaskOutput,
  evictTaskOutput,
} from '../../utils/task/diskOutput.js'
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
import { handleWrite, sendKeysSequence } from './handlers/write.js'
import { forwardResizeIntoSandbox, wrapNewSessionForSandbox } from './sandbox.js'
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
import { errorMessage } from '../../utils/errors.js'
import { quote } from '../../utils/bash/shellQuote.js'
import {
  createPermissionRequestMessage,
  getAskRuleForTool,
  getDenyRuleForTool,
} from '../../utils/permissions/permissions.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { bashToolHasPermission } from '../BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'

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

// Input typed into each session's current line but not yet submitted with
// Enter. Denied send-keys never reach the PTY, so this stays in sync with
// what the shell has buffered.
const terminalInputLines = new Map<string, string>()

/**
 * Replays keystrokes over a session's pending line like a line editor: Enter
 * (CR/LF) submits the line, Ctrl-C/Ctrl-U clear it, Backspace deletes a
 * character, and escape sequences and other control keys are ignored.
 */
export function applyTerminalKeystrokes(
  pending: string,
  sequence: string,
): { line: string; submitted: string[] } {
  let line = pending
  const submitted: string[] = []
  // Escape sequences (arrows, function keys) do not change the typed line.
  // eslint-disable-next-line no-control-regex
  const input = sequence.replace(/\x1b(?:\[[0-9;?]*[@-~]|O.)?/g, '')
  for (const char of input) {
    if (char === '\r' || char === '\n') {
      if (line.trim()) submitted.push(line)
      line = ''
    } else if (char === '\x03' || char === '\x15') {
      line = ''
    } else if (char === '\x7f' || char === '\b') {
      line = line.slice(0, -1)
    } else if (char >= ' ') {
      line += char
    }
  }
  return { line, submitted }
}

type TerminalPermissionInput = {
  action: string
  command?: string
  args?: string[]
  target?: string
  text?: string
  key?: Parameters<typeof sendKeysSequence>[0]['key']
  enter?: boolean
}

function getSendKeysLines(input: TerminalPermissionInput) {
  const pending = (input.target && terminalInputLines.get(input.target)) || ''
  return { pending, ...applyTerminalKeystrokes(pending, sendKeysSequence(input)) }
}

// The shell input a Terminal action would run: `submitted` is executed now,
// `typed` only sits on the command line. Undefined for actions that only
// read, resize or stop an existing session.
function getTerminalCommand(
  input: TerminalPermissionInput,
): { submitted?: string; typed?: string } | undefined {
  if (input.action === 'new-session') {
    return {
      submitted: quote([
        input.command?.trim() || process.env.SHELL || 'sh',
        ...(input.args ?? []),
      ]),
    }
  }
  if (input.action !== 'send-keys') return undefined
  const { pending, line, submitted } = getSendKeysLines(input)
  if (submitted.length > 0) {
    return { submitted: submitted.join('\n'), typed: line.trim() ? line : undefined }
  }
  return line.trim() && line !== pending ? { typed: line } : undefined
}

async function checkShellCommand(
  command: string,
  context: Parameters<typeof bashToolHasPermission>[1],
): Promise<PermissionResult> {
  // Terminal runs shell input, so Bash rules apply to it like they do to
  // Monitor. Whole-tool Bash rules are not part of bashToolHasPermission.
  const permissionContext = context.getAppState().toolPermissionContext
  const bashDenyRule = getDenyRuleForTool(permissionContext, {
    name: BASH_TOOL_NAME,
  })
  if (bashDenyRule) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BASH_TOOL_NAME} has been denied.`,
      decisionReason: { type: 'rule', rule: bashDenyRule },
    }
  }
  // Sandbox auto-allow does not apply to Terminal, sandboxed or not.
  const result = await bashToolHasPermission(
    { command, dangerouslyDisableSandbox: true },
    context,
  )
  if (result.behavior === 'deny') {
    return result
  }
  const bashAskRule = getAskRuleForTool(permissionContext, {
    name: BASH_TOOL_NAME,
  })
  if (bashAskRule) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(TERMINAL_TOOL_NAME),
      decisionReason: { type: 'rule', rule: bashAskRule },
    }
  }
  return result
}

let terminalManagerInstance: PtySessionManager | undefined
let unregisterTerminalManagerCleanup: (() => void) | undefined

export function getTerminalManager(): PtySessionManager {
  if (!terminalManagerInstance) {
    const manager = new PtySessionManager({
      driver: createBunPtyDriver(),
      maxBufferedChunks: DEFAULT_MAX_BUFFERED_CHUNKS,
    })
    terminalManagerInstance = manager
    unregisterTerminalManagerCleanup = registerCleanup(async () => {
      manager.closeAll()
    })
  }
  return terminalManagerInstance
}

export function resetTerminalManagerForTesting(manager?: PtySessionManager): void {
  unregisterTerminalManagerCleanup?.()
  unregisterTerminalManagerCleanup = undefined
  terminalManagerInstance = manager
  for (const poller of terminalTaskPollers.values()) {
    clearInterval(poller)
  }
  terminalTaskPollers.clear()
  terminalTaskRegistry.clear()
  terminalInputLines.clear()
  terminalTerminationReasons.clear()
  sandboxedTerminalSessions.clear()
}

export const terminalTaskRegistry = new Map<string, string>()
const terminalTaskPollers = new Map<string, ReturnType<typeof setInterval>>()
const terminalTerminationReasons = new Map<string, TerminalTerminationReason>()
// Sessions started inside the Bash sandbox.
const sandboxedTerminalSessions = new Set<string>()
const TERMINAL_TASK_POLL_INTERVAL_MS = 1000

function stopTerminalTaskPolling(sessionId: string): void {
  const poller = terminalTaskPollers.get(sessionId)
  if (!poller) {
    return
  }
  clearInterval(poller)
  terminalTaskPollers.delete(sessionId)
}

async function finalizeTerminalTask(
  sessionId: string,
  setAppState: Parameters<typeof updateTaskState>[1],
  input: Parameters<typeof syncTerminalTaskAfterStatus>[1],
): Promise<void> {
  const taskId = terminalTaskRegistry.get(sessionId)
  if (!taskId) {
    return
  }

  terminalTaskRegistry.delete(sessionId)
  terminalInputLines.delete(sessionId)
  terminalTerminationReasons.delete(sessionId)
  stopTerminalTaskPolling(sessionId)
  if (sandboxedTerminalSessions.delete(sessionId)) {
    SandboxManager.cleanupAfterCommand()
  }

  let finalTask: TerminalTaskState | undefined
  updateTaskState<TerminalTaskState>(taskId, setAppState, task => {
    const updated = syncTerminalTaskAfterStatus(task, input)
    if (updated !== task && updated.status !== 'running') {
      finalTask = updated
    }
    return updated
  })

  if (!finalTask) {
    return
  }
  appendTaskOutput(taskId, finalTask.preview)
  await evictTaskOutput(taskId)
  enqueueTerminalTaskNotification(taskId, setAppState)
}

function startTerminalTaskPolling(
  sessionId: string,
  setAppState: Parameters<typeof updateTaskState>[1],
): void {
  stopTerminalTaskPolling(sessionId)
  const poller = setInterval(() => {
    if (!terminalTaskRegistry.has(sessionId)) {
      stopTerminalTaskPolling(sessionId)
      return
    }
    void refreshTerminalTaskPreview(
      sessionId,
      setAppState,
      getTerminalManager(),
    ).catch(error =>
      finalizeTerminalTask(sessionId, setAppState, {
        status: { state: 'failed' },
        preview: '',
        terminationReason: 'driver-error',
        error: errorMessage(error),
      }),
    )
  }, TERMINAL_TASK_POLL_INTERVAL_MS)
  poller.unref()
  terminalTaskPollers.set(sessionId, poller)
}

registerTerminalTaskRuntimeKiller(async (task, setAppState) => {
  const manager = getTerminalManager()
  try {
    manager.signal(task.sessionId, 'SIGTERM')
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('SESSION_ALREADY_CLOSED:'))) {
      throw error
    }
  }
  await refreshTerminalTaskPreview(
    task.sessionId,
    setAppState,
    manager,
    'task-stop',
  )
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

export async function refreshTerminalTaskPreview(
  sessionId: string,
  setAppState: Parameters<typeof updateTaskState>[1],
  manager: PtySessionManager = getTerminalManager(),
  terminationReason?: TerminalTerminationReason,
): Promise<void> {
  const snapshot = manager.snapshot(sessionId)
  if (
    snapshot.status.state === 'running' ||
    snapshot.status.state === 'starting'
  ) {
    if (terminationReason) {
      terminalTerminationReasons.set(sessionId, terminationReason)
    }
    updateTerminalTask(sessionId, setAppState, task =>
      syncTerminalTaskAfterStatus(task, {
        status: snapshot.status,
        preview: snapshot.preview,
      }),
    )
    return
  }
  const pendingTerminationReason =
    terminationReason ?? terminalTerminationReasons.get(sessionId)
  await finalizeTerminalTask(sessionId, setAppState, {
    status: snapshot.status,
    preview: snapshot.preview,
    terminationReason:
      pendingTerminationReason === 'signal' && !snapshot.status.signal
        ? undefined
        : pendingTerminationReason,
  })
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
  const message = errorMessage(error)
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
  searchHint: 'persistent terminal PTY sessions, interactive shell, REPL and TUI',
  shouldDefer: true,
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
  isConcurrencySafe(input) {
    // send-keys reads and updates the session's pending command line.
    return input.action !== 'send-keys'
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
      if (input.dangerouslyDisableSandbox) {
        parts.push('dangerouslyDisableSandbox=true')
      }
    }
    if (input.action === 'send-keys') {
      const command = getTerminalCommand(input)
      if (command?.submitted) {
        parts.push(`command=${JSON.stringify(command.submitted)}`)
      }
      if (command?.typed) {
        parts.push(`typed=${JSON.stringify(command.typed)}`)
      }
    }
    return parts.join(' ')
  },
  async checkPermissions(input, context) {
    const command = getTerminalCommand(input)
    // A line still being typed runs nothing yet: only deny rules apply to it,
    // and it is checked in full once Enter submits it.
    if (command?.typed !== undefined) {
      const typed = await checkShellCommand(command.typed, context)
      if (typed.behavior === 'deny') return typed
    }
    if (command?.submitted === undefined) {
      return { behavior: 'allow', updatedInput: input }
    }
    const result = await checkShellCommand(command.submitted, context)
    return 'updatedInput' in result && result.updatedInput
      ? { ...result, updatedInput: input }
      : result
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
  async call(input, context, _canUseTool, _assistantMessage, _onProgress) {
    const setTaskAppState = context.setAppStateForTasks ?? context.setAppState
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
          const sandboxed = await wrapNewSessionForSandbox(parsed.data)
          const handled = await handleOpen(
            getTerminalManager(),
            sandboxed?.open ?? parsed.data,
          )
          // Report the command that runs, not the sandbox wrapper.
          const opened = sandboxed
            ? {
                ...handled,
                command: sandboxed.command,
                args: sandboxed.args,
                sandboxed: true,
              }
            : handled
          const target = String(opened.sessionId)
          if (sandboxed) sandboxedTerminalSessions.add(target)
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
              args: opened.args,
              cwd: parsed.data.cwd || process.cwd(),
              cols: opened.cols,
              rows: opened.rows,
              preview: String(opened.preview ?? ''),
              closed: false,
              agentId: context.agentId,
            },
            setTaskAppState,
          )
          startTerminalTaskPolling(target, setTaskAppState)
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
          const { line } = getSendKeysLines(parsed.data)
          const written = handleWrite(manager, parsed.data)
          terminalInputLines.set(parsed.data.target, line)
          await refreshTerminalTaskPreview(parsed.data.target, setTaskAppState, manager)
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
          await refreshTerminalTaskPreview(parsed.data.target, setTaskAppState, manager)
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
          const pid = manager.status(parsed.data.target).pid
          if (sandboxedTerminalSessions.has(parsed.data.target) && pid) {
            forwardResizeIntoSandbox(pid)
          }
          await refreshTerminalTaskPreview(parsed.data.target, setTaskAppState, manager)
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
          await refreshTerminalTaskPreview(
            parsed.data.target,
            setTaskAppState,
            manager,
            'signal',
          )
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
          await refreshTerminalTaskPreview(
            parsed.data.target,
            setTaskAppState,
            manager,
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
          const wasRunning = manager.status(parsed.data.target).state === 'running'
          const closed = handleClose(manager, parsed.data)
          await refreshTerminalTaskPreview(
            parsed.data.target,
            setTaskAppState,
            manager,
            wasRunning ? 'kill-pane' : undefined,
          )
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
