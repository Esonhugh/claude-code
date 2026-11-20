import type { ToolResultBlockParam, ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  createUserMessage,
  REJECT_MESSAGE,
  withMemoryCorrectionHint,
} from 'src/utils/messages.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  findToolByName,
  type StoppedResultWait,
  type Tools,
  type ToolUseContext,
} from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { isCodeModeEnabled } from '../../tools/REPLTool/codeModeGate.js'
import { isReplModeEnabled, REPL_TOOL_NAME } from '../../tools/REPLTool/constants.js'
import { STOP_AND_WAIT } from '../../tools/REPLTool/stopReport.js'
import { isShuttingDown } from '../../utils/gracefulShutdown.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { runToolUse, unknownToolSuffix } from './toolExecution.js'
import type { ModSnapshot } from '../mods/runtime.js'
import { createToolCatalogForContext } from '../mods/toolCatalog.js'
import { createModToolHost } from '../mods/toolHost.js'
import { captureModSessionUsage } from '../mods/sessionUsage.js'

type MessageUpdate = {
  message?: Message
  newContext?: ToolUseContext
}

type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded'

type TrackedTool = {
  id: string
  block: ToolUseBlock
  assistantMessage: AssistantMessage
  status: ToolStatus
  isConcurrencySafe: boolean
  promise?: Promise<void>
  results?: Message[]
  // Progress messages are stored separately and yielded immediately
  pendingProgress: Message[]
  contextModifiers?: Array<(context: ToolUseContext) => ToolUseContext>
  stopWait?: StopWait
}

/** Official `stopWait`: the executor waiting for a stopped REPL call's own result. */
type StopWait = {
  kept: boolean
  taken: boolean
  withdrawn: boolean
  timedOut: boolean
  hookController: AbortController
  timer?: ReturnType<typeof setTimeout>
  commit?: () => void
}

/**
 * Official `N0s`: how long a user stop waits for REPL to hand back its stopped
 * result. Past it the call gets REJECT_MESSAGE, as other tools do.
 */
export const STOPPED_RESULT_WAIT_MS = 10_000
let stoppedResultWaitMs = STOPPED_RESULT_WAIT_MS

export function setStoppedResultWaitMsForTesting(ms: number | undefined): void {
  stoppedResultWaitMs = ms ?? STOPPED_RESULT_WAIT_MS
}

/** Official `CEs`: REPL in REPL mode, unless a mod hooks its `tool.call`. */
function waitsForStoppedResult(name: string, snapshot: ModSnapshot | undefined): boolean {
  return (
    name === REPL_TOOL_NAME &&
    isCodeModeEnabled() &&
    isReplModeEnabled() &&
    snapshot?.hasHooks('tool.call', { tool: name }) !== true &&
    snapshot?.hasHooks('tool.run', { tool: name }) !== true
  )
}

/** Official `TEs`: Esc, a remote stop, or `abort()` with no reason (a declined permission prompt). */
function isUserStopAbort(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason
  if (reason === 'user-cancel' || reason === 'remote-cancel') return true
  if (!(reason instanceof DOMException) || reason.name !== 'AbortError') return false
  const plain = new AbortController()
  plain.abort()
  return reason.message === (plain.signal.reason as DOMException).message
}

/** Official `ly`: the kept result marked as a user stop, with the stop sentence after it. */
function markUserStopped(message: Message, toolUseId: string): Message {
  if (message.type !== 'user' || message.toolDenialKind !== undefined) return message
  const content = message.message.content
  return {
    ...message,
    toolDenialKind: 'user-rejected',
    message: {
      ...message.message,
      content:
        typeof content === 'string'
          ? content
          : content.map(part => {
              if (part.type !== 'tool_result' || part.tool_use_id !== toolUseId) return part
              const blocks =
                typeof part.content === 'string'
                  ? part.content === ''
                    ? []
                    : [{ type: 'text' as const, text: part.content }]
                  : ((part.content ?? []) as Exclude<ToolResultBlockParam['content'], string | undefined>)
              return {
                ...part,
                content: [...blocks, { type: 'text' as const, text: `The user stopped this call. ${STOP_AND_WAIT}` }],
              }
            }),
    },
  }
}

function isResultFor(message: Message, toolUseId: string): boolean {
  return (
    message.type === 'user' &&
    Array.isArray(message.message.content) &&
    message.message.content.some(part => part.type === 'tool_result' && part.tool_use_id === toolUseId)
  )
}

/**
 * Executes tools as they stream in with concurrency control.
 * - Concurrent-safe tools can execute in parallel with other concurrent-safe tools
 * - Non-concurrent tools must execute alone (exclusive access)
 * - Results are buffered and emitted in the order tools were received
 */
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private toolUseContext: ToolUseContext
  private hasErrored = false
  private erroredToolDescription = ''
  // Child of toolUseContext.abortController. Fires when a Bash tool errors
  // so sibling subprocesses die immediately instead of running to completion.
  // Aborting this does NOT abort the parent — query.ts won't end the turn.
  private siblingAbortController: AbortController
  private discarded = false
  private modsSnapshot?: ModSnapshot
  // The query's own snapshot; the context handed back keeps it, like runTools.
  private readonly queryModsSnapshot?: ModSnapshot
  private admissionClosed = false
  // Signal to wake up getRemainingResults when progress is available
  private progressAvailableResolve?: () => void

  constructor(
    private readonly toolDefinitions: Tools,
    private readonly canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
  ) {
    this.toolUseContext = toolUseContext
    this.queryModsSnapshot = toolUseContext.modsSnapshot
    this.siblingAbortController = createChildAbortController(
      toolUseContext.abortController,
    )
  }

  /**
   * Discards all pending and in-progress tools. Called when streaming fallback
   * occurs and results from the failed attempt should be abandoned.
   * Queued tools won't start, and in-progress tools will receive synthetic errors.
   */
  discard(): void {
    this.discarded = true
    if (this.modsSnapshot) {
      this.admissionClosed = true
      this.releaseModsSnapshot()
    }
  }

  private releaseModsSnapshot(): void {
    if (
      !this.admissionClosed ||
      this.hasExecutingTools() ||
      (!this.discarded && this.tools.some(tool => tool.status === 'queued'))
    )
      return
    const snapshot = this.modsSnapshot
    this.modsSnapshot = undefined
    if (snapshot) {
      this.toolUseContext = {
        ...this.toolUseContext,
        modsSnapshot: this.queryModsSnapshot,
      }
      snapshot.release()
    }
  }

  /**
   * Add a tool to the execution queue. Will start executing immediately if conditions allow.
   */
  addTool(block: ToolUseBlock, assistantMessage: AssistantMessage): void {
    if (this.toolUseContext.mods) {
      if (this.admissionClosed || this.discarded)
        throw new Error('Tool executor admission is closed')
      if (!this.modsSnapshot) {
        this.modsSnapshot = this.toolUseContext.mods.capture({
          toolCatalog: () => createToolCatalogForContext(this.toolUseContext),
          toolHost: () => createModToolHost(this.toolUseContext, this.canUseTool),
          captureUsage: () =>
            captureModSessionUsage({
              ...this.toolUseContext,
              messages: [
                ...this.toolUseContext.messages,
                ...this.tools.map(tool => tool.assistantMessage),
                assistantMessage,
              ].filter(
                (message, index, messages) =>
                  messages.findIndex(item => item.uuid === message.uuid) === index,
              ),
            }),
        })
        this.toolUseContext = {
          ...this.toolUseContext,
          modsSnapshot: this.modsSnapshot,
        }
      }
    }
    const toolDefinition = findToolByName(this.toolDefinitions, block.name)
    if (!toolDefinition) {
      const error = `Error: No such tool available: ${block.name}${unknownToolSuffix(block.name, this.toolUseContext.getAppState().toolPermissionContext, this.toolDefinitions.map(t => t.name))}`
      this.tools.push({
        id: block.id,
        block,
        assistantMessage,
        status: 'completed',
        isConcurrencySafe: true,
        pendingProgress: [],
        results: [
          createUserMessage({
            content: [
              {
                type: 'tool_result',
                content: `<tool_use_error>${error}</tool_use_error>`,
                is_error: true,
                tool_use_id: block.id,
              },
            ],
            toolUseResult: error,
            sourceToolAssistantUUID: assistantMessage.uuid,
          }),
        ],
      })
      return
    }

    const parsedInput = toolDefinition.inputSchema.safeParse(
      toolDefinition.coerceInput?.(block.input)?.input ?? block.input,
    )
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(toolDefinition.isConcurrencySafe(parsedInput.data))
          } catch {
            return false
          }
        })()
      : false
    this.tools.push({
      id: block.id,
      block,
      assistantMessage,
      status: 'queued',
      isConcurrencySafe,
      pendingProgress: [],
    })

    void this.processQueue()
  }

  /**
   * Check if a tool can execute based on current concurrency state
   */
  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executingTools = this.tools.filter(t => t.status === 'executing')
    return (
      executingTools.length === 0 ||
      (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
    )
  }

  /**
   * Process the queue, starting tools when concurrency conditions allow
   */
  private async processQueue(): Promise<void> {
    if (this.discarded && this.toolUseContext.mods) return
    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        await this.executeTool(tool)
      } else {
        // Can't execute this tool yet, and since we need to maintain order for non-concurrent tools, stop here
        if (!tool.isConcurrencySafe) break
      }
    }
  }

  private createSyntheticErrorMessage(
    toolUseId: string,
    reason: 'sibling_error' | 'user_interrupted' | 'streaming_fallback',
    assistantMessage: AssistantMessage,
  ): Message {
    // For user interruptions (ESC to reject), use REJECT_MESSAGE so the UI shows
    // "User rejected edit" instead of "Error editing file"
    if (reason === 'user_interrupted') {
      return createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: withMemoryCorrectionHint(REJECT_MESSAGE),
            is_error: true,
            tool_use_id: toolUseId,
          },
        ],
        toolUseResult: 'User rejected tool use',
        toolDenialKind: 'user-rejected',
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
    if (reason === 'streaming_fallback') {
      return createUserMessage({
        content: [
          {
            type: 'tool_result',
            content:
              '<tool_use_error>Error: Streaming fallback - tool execution discarded</tool_use_error>',
            is_error: true,
            tool_use_id: toolUseId,
          },
        ],
        toolUseResult: 'Streaming fallback - tool execution discarded',
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
    const desc = this.erroredToolDescription
    const msg = desc
      ? `Cancelled: parallel tool call ${desc} errored`
      : 'Cancelled: parallel tool call errored'
    return createUserMessage({
      content: [
        {
          type: 'tool_result',
          content: `<tool_use_error>${msg}</tool_use_error>`,
          is_error: true,
          tool_use_id: toolUseId,
        },
      ],
      toolUseResult: msg,
      toolDenialKind: 'cancelled',
      sourceToolAssistantUUID: assistantMessage.uuid,
    })
  }

  /**
   * Determine why a tool should be cancelled.
   */
  private getAbortReason(
    tool: TrackedTool,
  ): 'sibling_error' | 'user_interrupted' | 'streaming_fallback' | null {
    if (this.discarded) {
      return 'streaming_fallback'
    }
    if (this.hasErrored) {
      return 'sibling_error'
    }
    if (this.toolUseContext.abortController.signal.aborted) {
      // 'interrupt' means the user typed a new message while tools were
      // running. Only cancel tools whose interruptBehavior is 'cancel';
      // 'block' tools shouldn't reach here (abort isn't fired).
      if (this.toolUseContext.abortController.signal.reason === 'interrupt') {
        return this.getToolInterruptBehavior(tool) === 'cancel'
          ? 'user_interrupted'
          : null
      }
      return 'user_interrupted'
    }
    return null
  }

  private getToolInterruptBehavior(tool: TrackedTool): 'cancel' | 'block' {
    const definition = findToolByName(this.toolDefinitions, tool.block.name)
    if (!definition?.interruptBehavior) return 'block'
    try {
      return definition.interruptBehavior()
    } catch {
      return 'block'
    }
  }

  private getToolDescription(tool: TrackedTool): string {
    const input = tool.block.input as Record<string, unknown> | undefined
    const summary = input?.command ?? input?.file_path ?? input?.pattern ?? ''
    if (typeof summary === 'string' && summary.length > 0) {
      const truncated =
        summary.length > 40 ? summary.slice(0, 40) + '\u2026' : summary
      return `${tool.block.name}(${truncated})`
    }
    return tool.block.name
  }

  private updateInterruptibleState(): void {
    const executing = this.tools.filter(t => t.status === 'executing')
    this.toolUseContext.setHasInterruptibleToolInProgress?.(
      executing.length > 0 &&
        executing.every(t => this.getToolInterruptBehavior(t) === 'cancel'),
    )
  }

  /**
   * Official `armStoppedResultWait`: on a user stop, wait up to
   * STOPPED_RESULT_WAIT_MS for the call's stopped result; `fallback` ends the
   * call with REJECT_MESSAGE if it does not come in time.
   */
  private armStoppedResultWait(tool: TrackedTool, fallback: () => void): void {
    const signal = this.toolUseContext.abortController.signal
    if (
      tool.status !== 'executing' ||
      tool.stopWait !== undefined ||
      !signal.aborted ||
      isShuttingDown() ||
      !isUserStopAbort(signal)
    )
      return
    const wait: StopWait = {
      kept: false,
      taken: false,
      withdrawn: false,
      timedOut: false,
      hookController: new AbortController(),
    }
    wait.timer = setTimeout(() => {
      if (tool.status !== 'executing') return
      wait.timedOut = true
      wait.commit = undefined
      wait.hookController.abort(signal.reason)
      fallback()
    }, stoppedResultWaitMs)
    tool.stopWait = wait
  }

  /** Official `takeKeptResult`: the kept result is sent, and its commit runs. */
  private takeKeptResult(tool: TrackedTool, message: Message): Message {
    const wait = tool.stopWait
    if (wait === undefined || !isResultFor(message, tool.id)) return message
    clearTimeout(wait.timer)
    wait.taken = true
    const commit = wait.commit
    wait.commit = undefined
    commit?.()
    return markUserStopped(message, tool.id)
  }

  /** Official `stoppedResultWaitOf`. */
  private stoppedResultWaitOf(tool: TrackedTool): StoppedResultWait | undefined {
    const wait = tool.stopWait
    if (wait === undefined) return undefined
    return {
      hookController: wait.hookController,
      get kept() {
        return wait.kept
      },
      keep: commit => {
        if (wait.timedOut || wait.withdrawn || wait.taken) return false
        wait.kept = true
        wait.commit = commit
        return true
      },
      withdraw: () => {
        if (wait.taken) return
        wait.withdrawn = true
        wait.kept = false
        wait.commit = undefined
      },
    }
  }

  /**
   * Execute a tool and collect its results
   */
  private async executeTool(tool: TrackedTool): Promise<void> {
    tool.status = 'executing'
    this.toolUseContext.setInProgressToolUseIDs(prev =>
      new Set(prev).add(tool.id),
    )
    this.updateInterruptibleState()

    const messages: Message[] = []
    const contextModifiers: Array<(context: ToolUseContext) => ToolUseContext> =
      []

    const collectResults = async () => {
      // If already aborted (by error or user), generate synthetic error block instead of running the tool
      const initialAbortReason = this.getAbortReason(tool)
      if (initialAbortReason) {
        messages.push(
          this.createSyntheticErrorMessage(
            tool.id,
            initialAbortReason,
            tool.assistantMessage,
          ),
        )
        tool.results = messages
        tool.contextModifiers = contextModifiers
        tool.status = 'completed'
        this.updateInterruptibleState()
        return
      }

      // Per-tool child controller. Lets siblingAbortController kill running
      // subprocesses (Bash spawns listen to this signal) when a Bash error
      // cascades. Permission-dialog rejection also aborts this controller
      // (PermissionContext.ts cancelAndAbort) — that abort must bubble up to
      // the query controller so the query loop's post-tool abort check ends
      // the turn. Without bubble-up, ExitPlanMode "clear context + auto"
      // sends REJECT_MESSAGE to the model instead of aborting (#21056 regression).
      const toolAbortController = createChildAbortController(
        this.siblingAbortController,
      )
      toolAbortController.signal.addEventListener(
        'abort',
        () => {
          if (
            toolAbortController.signal.reason !== 'sibling_error' &&
            !this.toolUseContext.abortController.signal.aborted &&
            !this.discarded
          ) {
            this.toolUseContext.abortController.abort(
              toolAbortController.signal.reason,
            )
          }
        },
        { once: true },
      )

      // Official `I`: a user stop while REPL runs waits for its stopped result.
      const querySignal = this.toolUseContext.abortController.signal
      const onStop = waitsForStoppedResult(
        tool.block.name,
        this.modsSnapshot ?? this.toolUseContext.modsSnapshot,
      )
        ? () =>
            this.armStoppedResultWait(tool, () => {
              messages.push(
                this.createSyntheticErrorMessage(
                  tool.id,
                  'user_interrupted',
                  tool.assistantMessage,
                ),
              )
              tool.results = messages
              tool.contextModifiers = contextModifiers
              tool.status = 'completed'
              this.updateInterruptibleState()
              this.progressAvailableResolve?.()
              this.progressAvailableResolve = undefined
            })
        : undefined
      if (onStop) querySignal.addEventListener('abort', onStop, { once: true })

      const generator = runToolUse(
        tool.block,
        tool.assistantMessage,
        this.canUseTool,
        {
          ...this.toolUseContext,
          abortController: toolAbortController,
          ...(onStop && {
            stoppedResultWait: (toolUseId: string) =>
              toolUseId === tool.id ? this.stoppedResultWaitOf(tool) : undefined,
          }),
        },
      )

      // Track if this specific tool has produced an error result.
      // This prevents the tool from receiving a duplicate "sibling error"
      // message when it is the one that caused the error.
      let thisToolErrored = false

      try {
        for await (const update of generator) {
          const wait = tool.stopWait
          if (wait?.timedOut) break
          if (wait?.kept && !wait.taken && isShuttingDown()) {
            wait.kept = false
            wait.commit = undefined
          }
          // Check if we were aborted by a sibling tool error or user interruption.
          // Only add the synthetic error if THIS tool didn't produce the error.
          // Official `ay`: a stop waiting on REPL lets its progress and kept result through.
          const abortReason = this.getAbortReason(tool)
          if (
            abortReason &&
            !thisToolErrored &&
            !(
              abortReason === 'user_interrupted' &&
              wait !== undefined &&
              (wait.kept || update.message?.type === 'progress')
            )
          ) {
            clearTimeout(wait?.timer)
            messages.push(
              this.createSyntheticErrorMessage(
                tool.id,
                abortReason,
                tool.assistantMessage,
              ),
            )
            break
          }

          const isErrorResult =
            update.message.type === 'user' &&
            Array.isArray(update.message.message.content) &&
            update.message.message.content.some(
              _ => _.type === 'tool_result' && _.is_error === true,
            )

          if (isErrorResult) {
            thisToolErrored = true
            // Only Bash errors cancel siblings. Bash commands often have implicit
            // dependency chains (e.g. mkdir fails → subsequent commands pointless).
            // Read/WebFetch/etc are independent — one failure shouldn't nuke the rest.
            if (tool.block.name === BASH_TOOL_NAME) {
              this.hasErrored = true
              this.erroredToolDescription = this.getToolDescription(tool)
              this.siblingAbortController.abort('sibling_error')
            }
          }

          if (update.message) {
            // Progress messages go to pendingProgress for immediate yielding
            if (update.message.type === 'progress') {
              tool.pendingProgress.push(update.message)
              // Signal that progress is available
              if (this.progressAvailableResolve) {
                this.progressAvailableResolve()
                this.progressAvailableResolve = undefined
              }
            } else {
              messages.push(
                tool.stopWait?.kept
                  ? this.takeKeptResult(tool, update.message)
                  : update.message,
              )
            }
          }
          if (update.contextModifier) {
            contextModifiers.push(update.contextModifier.modifyContext)
          }
        }
      } finally {
        if (onStop) querySignal.removeEventListener('abort', onStop)
        clearTimeout(tool.stopWait?.timer)
      }
      // The wait ran out and the call already ended with REJECT_MESSAGE.
      if (tool.stopWait?.timedOut) return
      tool.results = messages
      tool.contextModifiers = contextModifiers
      tool.status = 'completed'
      this.updateInterruptibleState()

      // NOTE: we currently don't support context modifiers for concurrent
      //       tools. None are actively being used, but if we want to use
      //       them in concurrent tools, we need to support that here.
      if (!tool.isConcurrencySafe && contextModifiers.length > 0) {
        for (const modifier of contextModifiers) {
          this.toolUseContext = modifier(this.toolUseContext)
          if (this.modsSnapshot)
            this.toolUseContext = {
              ...this.toolUseContext,
              modsSnapshot: this.modsSnapshot,
            }
        }
      }
    }

    const promise = collectResults()
    tool.promise = promise

    // Process more queue when done
    void promise.finally(() => {
      this.releaseModsSnapshot()
      void this.processQueue()
    })
  }

  /**
   * Get any completed results that haven't been yielded yet (non-blocking)
   * Maintains order where necessary
   * Also yields any pending progress messages immediately
   */
  *getCompletedResults(): Generator<MessageUpdate, void> {
    if (this.discarded) {
      return
    }

    for (const tool of this.tools) {
      // Always yield pending progress messages immediately, regardless of tool status
      while (tool.pendingProgress.length > 0) {
        const progressMessage = tool.pendingProgress.shift()!
        yield {
          message: progressMessage,
          newContext: this.getUpdatedContext(),
        }
      }

      if (tool.status === 'yielded') {
        continue
      }

      if (tool.status === 'completed' && tool.results) {
        tool.status = 'yielded'

        for (const message of tool.results) {
          yield { message, newContext: this.getUpdatedContext() }
        }

        markToolUseAsComplete(this.toolUseContext, tool.id)
      } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
        break
      }
    }
  }

  /**
   * Check if any tool has pending progress messages
   */
  private hasPendingProgress(): boolean {
    return this.tools.some(t => t.pendingProgress.length > 0)
  }

  /**
   * Wait for remaining tools and yield their results as they complete
   * Also yields progress messages as they become available
   */
  async *getRemainingResults(): AsyncGenerator<MessageUpdate, void> {
    this.admissionClosed = true
    try {
      if (this.discarded) {
        if (this.modsSnapshot)
          await Promise.allSettled(
            this.tools.flatMap(tool => (tool.promise ? [tool.promise] : [])),
          )
        return
      }

      while (this.hasUnfinishedTools()) {
        await this.processQueue()

        for (const result of this.getCompletedResults()) {
          yield result
        }

        // If we still have executing tools but nothing completed, wait for any to complete
        // OR for progress to become available
        if (
          this.hasExecutingTools() &&
          !this.hasCompletedResults() &&
          !this.hasPendingProgress()
        ) {
          const executingPromises = this.tools
            .filter(t => t.status === 'executing' && t.promise)
            .map(t => t.promise!)

          // Also wait for progress to become available
          const progressPromise = new Promise<void>(resolve => {
            this.progressAvailableResolve = resolve
          })

          if (executingPromises.length > 0) {
            await Promise.race([...executingPromises, progressPromise])
          }
        }
      }

      for (const result of this.getCompletedResults()) {
        yield result
      }
    } finally {
      if (this.modsSnapshot) {
        this.discarded = true
        await Promise.allSettled(
          this.tools.flatMap(tool => (tool.promise ? [tool.promise] : [])),
        )
        this.releaseModsSnapshot()
      }
    }
  }

  /**
   * Check if there are any completed results ready to yield
   */
  private hasCompletedResults(): boolean {
    return this.tools.some(t => t.status === 'completed')
  }

  /**
   * Check if there are any tools still executing
   */
  private hasExecutingTools(): boolean {
    return this.tools.some(t => t.status === 'executing')
  }

  /**
   * Check if there are any unfinished tools
   */
  private hasUnfinishedTools(): boolean {
    return this.tools.some(t => t.status !== 'yielded')
  }

  /**
   * Get the current tool use context (may have been modified by context modifiers)
   */
  getUpdatedContext(): ToolUseContext {
    return this.modsSnapshot
      ? { ...this.toolUseContext, modsSnapshot: this.queryModsSnapshot }
      : this.toolUseContext
  }
}

function markToolUseAsComplete(
  toolUseContext: ToolUseContext,
  toolUseID: string,
) {
  toolUseContext.setInProgressToolUseIDs(prev => {
    const next = new Set(prev)
    next.delete(toolUseID)
    return next
  })
}
