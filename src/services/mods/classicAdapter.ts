import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { PermissionRequestResult } from '../../types/hooks.js'
import type { HookInput } from '../../entrypoints/agentSdkTypes.js'
import {
  executePreToolHooks,
  executePostToolHooks,
  executePostToolUseFailureHooks,
  executePermissionDeniedHooks,
  executeStopHooks,
  executeSessionStartHooks,
  executeSetupHooks,
  executeSubagentStartHooks,
  executePermissionRequestHooks,
  executeUserPromptSubmitHooks,
  type AggregatedHookResult,
  type HookSourceScope,
} from '../../utils/hooks.js'

export type ModClassicAdapterOptions = {
  sourceScope?: HookSourceScope
  getToolUseContext: () => ToolUseContext
  getSessionId: () => string
  getMessages: () => Message[]
  /** PermissionRequest's stdin shape omits the tool-use ID; the host retains it. */
  getToolUseID: () => string
  /**
   * Receives progress/diagnostics and host-only metadata (goal hooks, source,
   * PreToolUse stop). Do not also apply raw contexts/decisions here: the method
   * returns their folded answer, which the caller consumes exactly once.
   */
  onHookResult: (
    event: string,
    result: AggregatedHookResult,
  ) => void | Promise<void>
}

export type ClassicPreToolUseInput = {
  tool: string
  tool_use_id: string
  [argument: string]: unknown
}
export type ClassicPreToolUseResult = (
  | { allow: true; ask?: never; deny?: never }
  | { ask: string; allow?: never; deny?: never }
  | { deny: string; allow?: never; ask?: never }
  | { allow?: never; ask?: never; deny?: never }
) & {
  updatedInput?: Record<string, unknown>
  additionalContext?: string[]
}

type ClassicInput<E extends HookInput['hook_event_name']> = Extract<
  HookInput,
  { hook_event_name: E }
>
type ClassicEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStop'
  | 'SessionStart'
  | 'Setup'
  | 'SubagentStart'

function validateInput(event: ClassicEvent, input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError(`classic.${event} requires an object`)
  const value = input as Record<string, unknown>
  if (event !== 'PreToolUse' && value.hook_event_name !== event)
    throw new TypeError(`classic.${event} requires hook_event_name ${event}`)
  const fields: string[] = []
  if (event === 'PreToolUse') fields.push('tool', 'tool_use_id')
  if (
    [
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionDenied',
      'PermissionRequest',
    ].includes(event)
  ) {
    fields.push('tool_name')
    if (!Object.hasOwn(value, 'tool_input'))
      throw new TypeError(`classic.${event} requires tool_input`)
    if (event !== 'PermissionRequest') fields.push('tool_use_id')
  }
  if (event === 'PostToolUse' && !Object.hasOwn(value, 'tool_response'))
    throw new TypeError('classic.PostToolUse requires tool_response')
  if (event === 'PostToolUseFailure') fields.push('error')
  if (event === 'PermissionDenied') fields.push('reason')
  if (event === 'UserPromptSubmit') fields.push('prompt')
  if (event === 'SubagentStart' || event === 'SubagentStop')
    fields.push('agent_id', 'agent_type')
  for (const field of fields) {
    if (typeof value[field] !== 'string')
      throw new TypeError(`classic.${event} requires a string ${field}`)
  }
  if (
    (event === 'Stop' || event === 'SubagentStop') &&
    typeof value.stop_hook_active !== 'boolean'
  )
    throw new TypeError(`classic.${event} requires boolean stop_hook_active`)
  if (
    event === 'SessionStart' &&
    !['startup', 'resume', 'clear', 'compact'].includes(value.source as string)
  )
    throw new TypeError('classic.SessionStart requires a valid source')
  if (
    event === 'Setup' &&
    !['init', 'maintenance'].includes(value.trigger as string)
  )
    throw new TypeError('classic.Setup requires a valid trigger')
}
export type ClassicResult = {
  block?: string
  preventContinuation?: true
  stopReason?: string
  additionalContext?: string[]
  updatedToolOutput?: unknown
  updatedMCPToolOutput?: unknown
  retry?: true
  initialUserMessage?: string
  watchPaths?: string[]
  decision?:
    | Exclude<PermissionRequestResult, { behavior: 'deny' }>
    | {
        behavior: 'deny'
        message?: string
        interrupt?: true
      }
}

/**
 * Host-side method table for classic events, not a tool/permission executor.
 * Source selection is passed explicitly to the existing executors; no global
 * settings or snapshot state is changed by an adapter invocation.
 * Getters must resolve the CURRENT invocation, including concurrent tools/agents.
 * Base stdin metadata is rebuilt by those executors, not taken from Mod input.
 * prompt.context is a separate engine event; it is not a classic hook method.
 */
export function createModClassicAdapter(options: ModClassicAdapterOptions) {
  async function fold(
    event: string,
    stream: AsyncIterable<AggregatedHookResult>,
    signal: AbortSignal,
  ): Promise<ClassicResult> {
    const result: ClassicResult = {}
    for await (const item of stream) {
      await options.onHookResult(event, item)
      signal.throwIfAborted()
      if (item.blockingError) result.block = item.blockingError.blockingError
      if (item.preventContinuation) result.preventContinuation = true
      if (item.stopReason !== undefined) result.stopReason = item.stopReason
      if (event === 'classic.SessionStart') {
        if (item.initialUserMessage !== undefined)
          result.initialUserMessage = item.initialUserMessage
        if (item.watchPaths !== undefined)
          result.watchPaths = [...item.watchPaths]
      }
      if (event === 'classic.PermissionDenied' && item.retry)
        result.retry = true
      if (
        event !== 'classic.PermissionRequest' &&
        event !== 'classic.PermissionDenied' &&
        item.additionalContexts
      )
        (result.additionalContext ??= []).push(...item.additionalContexts)
      if (
        event === 'classic.PermissionRequest' &&
        item.permissionRequestResult
      ) {
        const decision = item.permissionRequestResult
        if (decision.behavior === 'allow') result.decision = { ...decision }
        else {
          result.decision = { behavior: 'deny' }
          if (decision.message !== undefined)
            result.decision.message = decision.message
          if (decision.interrupt) result.decision.interrupt = true
        }
      }
      if (
        event === 'classic.PostToolUse' &&
        item.updatedToolOutput !== undefined
      )
        result.updatedToolOutput = item.updatedToolOutput
      if (
        event === 'classic.PostToolUse' &&
        item.updatedMCPToolOutput !== undefined
      )
        result.updatedMCPToolOutput = item.updatedMCPToolOutput
    }
    signal.throwIfAborted()
    return result
  }

  return {
    classic: {
      async SessionStart(
        input: ClassicInput<'SessionStart'> & {
          source: Parameters<typeof executeSessionStartHooks>[0]
        },
      ): Promise<ClassicResult> {
        validateInput('SessionStart', input)
        const context = options.getToolUseContext()
        const signal = context.abortController.signal
        signal.throwIfAborted()
        return fold(
          'classic.SessionStart',
          executeSessionStartHooks(
            input.source,
            options.getSessionId(),
            input.agent_type ?? context.agentType,
            input.model ?? context.options.mainLoopModel,
            signal,
            undefined,
            undefined,
            options.sourceScope,
          ),
          signal,
        )
      },
      async Setup(input: ClassicInput<'Setup'>): Promise<ClassicResult> {
        validateInput('Setup', input)
        const signal = options.getToolUseContext().abortController.signal
        signal.throwIfAborted()
        return fold(
          'classic.Setup',
          executeSetupHooks(
            input.trigger,
            signal,
            undefined,
            undefined,
            options.sourceScope,
          ),
          signal,
        )
      },
      async SubagentStart(
        input: ClassicInput<'SubagentStart'>,
      ): Promise<ClassicResult> {
        validateInput('SubagentStart', input)
        const signal = options.getToolUseContext().abortController.signal
        signal.throwIfAborted()
        return fold(
          'classic.SubagentStart',
          executeSubagentStartHooks(
            input.agent_id,
            input.agent_type,
            signal,
            undefined,
            options.sourceScope,
          ),
          signal,
        )
      },
      async PostToolUseFailure(
        input: ClassicInput<'PostToolUseFailure'>,
      ): Promise<ClassicResult> {
        validateInput('PostToolUseFailure', input)
        const context = options.getToolUseContext()
        const signal = context.abortController.signal
        signal.throwIfAborted()
        return fold(
          'classic.PostToolUseFailure',
          executePostToolUseFailureHooks(
            input.tool_name,
            input.tool_use_id,
            input.tool_input,
            input.error,
            context,
            input.is_interrupt,
            context.getAppState().toolPermissionContext.mode,
            signal,
            undefined,
            options.sourceScope,
          ),
          signal,
        )
      },
      async PermissionDenied(
        input: ClassicInput<'PermissionDenied'>,
      ): Promise<ClassicResult> {
        validateInput('PermissionDenied', input)
        const context = options.getToolUseContext()
        const signal = context.abortController.signal
        signal.throwIfAborted()
        return fold(
          'classic.PermissionDenied',
          executePermissionDeniedHooks(
            input.tool_name,
            input.tool_use_id,
            input.tool_input,
            input.reason,
            context,
            context.getAppState().toolPermissionContext.mode,
            signal,
            undefined,
            options.sourceScope,
          ),
          signal,
        )
      },
      async PermissionRequest(
        input: ClassicInput<'PermissionRequest'>,
      ): Promise<ClassicResult> {
        validateInput('PermissionRequest', input)
        const context = options.getToolUseContext()
        const signal = context.abortController.signal
        signal.throwIfAborted()
        return fold(
          'classic.PermissionRequest',
          executePermissionRequestHooks(
            input.tool_name,
            options.getToolUseID(),
            input.tool_input,
            context,
            context.getAppState().toolPermissionContext.mode,
            input.permission_suggestions,
            signal,
            undefined,
            context.requestPrompt,
            input.tool_input !== null &&
              typeof input.tool_input === 'object' &&
              !Array.isArray(input.tool_input)
              ? context.options.tools
                  .find(tool => tool.name === input.tool_name)
                  ?.getToolUseSummary?.(
                    input.tool_input as Record<string, unknown>,
                  )
              : undefined,
            options.sourceScope,
          ),
          signal,
        )
      },
      async Stop(input: ClassicInput<'Stop'>): Promise<ClassicResult> {
        validateInput('Stop', input)
        const context = options.getToolUseContext()
        const signal = context.abortController.signal
        signal.throwIfAborted()
        return fold(
          'classic.Stop',
          executeStopHooks(
            context.getAppState().toolPermissionContext.mode,
            signal,
            undefined,
            input.stop_hook_active,
            undefined,
            context,
            options.getMessages(),
            context.agentType,
            context.requestPrompt,
            options.sourceScope,
          ),
          signal,
        )
      },
      async SubagentStop(
        input: ClassicInput<'SubagentStop'>,
      ): Promise<ClassicResult> {
        validateInput('SubagentStop', input)
        const context = options.getToolUseContext()
        const signal = context.abortController.signal
        signal.throwIfAborted()
        return fold(
          'classic.SubagentStop',
          executeStopHooks(
            context.getAppState().toolPermissionContext.mode,
            signal,
            undefined,
            input.stop_hook_active,
            input.agent_id as ToolUseContext['agentId'],
            context,
            options.getMessages(),
            input.agent_type,
            context.requestPrompt,
            options.sourceScope,
          ),
          signal,
        )
      },
      async PostToolUse(
        input: ClassicInput<'PostToolUse'>,
      ): Promise<ClassicResult> {
        validateInput('PostToolUse', input)
        const context = options.getToolUseContext()
        const signal = context.abortController.signal
        signal.throwIfAborted()
        return fold(
          'classic.PostToolUse',
          executePostToolHooks(
            input.tool_name,
            input.tool_use_id,
            input.tool_input,
            input.tool_response,
            context,
            context.getAppState().toolPermissionContext.mode,
            signal,
            undefined,
            options.sourceScope,
          ),
          signal,
        )
      },
      async UserPromptSubmit(
        input: ClassicInput<'UserPromptSubmit'>,
      ): Promise<ClassicResult> {
        validateInput('UserPromptSubmit', input)
        const context = options.getToolUseContext()
        const signal = context.abortController.signal
        signal.throwIfAborted()
        return fold(
          'classic.UserPromptSubmit',
          executeUserPromptSubmitHooks(
            input.prompt,
            context.getAppState().toolPermissionContext.mode,
            context,
            context.requestPrompt,
            options.sourceScope,
          ),
          signal,
        )
      },
      async PreToolUse(
        input: ClassicPreToolUseInput,
      ): Promise<ClassicPreToolUseResult> {
        validateInput('PreToolUse', input)
        const context = options.getToolUseContext()
        const signal = context.abortController.signal
        signal.throwIfAborted()
        const { tool, tool_use_id, ...args } = input
        const result: Pick<
          ClassicPreToolUseResult,
          'updatedInput' | 'additionalContext'
        > = {}
        let decision: Pick<ClassicPreToolUseResult, 'allow' | 'ask' | 'deny'> =
          {}
        let stopped: string | undefined
        let blockingReason: string | undefined
        for await (const item of executePreToolHooks(
          tool,
          tool_use_id,
          args,
          context,
          context.getAppState().toolPermissionContext.mode,
          signal,
          undefined,
          context.requestPrompt,
          context.options.tools
            .find(candidate => candidate.name === tool)
            ?.getToolUseSummary?.(args),
          options.sourceScope,
        )) {
          await options.onHookResult('classic.PreToolUse', item)
          signal.throwIfAborted()
          if (item.additionalContexts)
            (result.additionalContext ??= []).push(...item.additionalContexts)
          if (item.preventContinuation)
            stopped = item.stopReason ?? 'Execution stopped by PreToolUse hook'
          if (item.updatedInput !== undefined)
            result.updatedInput = item.updatedInput
          if (item.blockingError)
            blockingReason = item.blockingError.blockingError
          if (item.blockingError || item.permissionBehavior === 'deny') {
            // Repeated executor decisions retain the winning hook's metadata.
            decision = {
              deny:
                blockingReason ??
                item.hookPermissionDecisionReason ??
                decision.deny ??
                'Blocked by hook',
            }
          } else if (
            item.permissionBehavior === 'ask' &&
            decision.deny === undefined
          ) {
            decision = {
              ask:
                item.hookPermissionDecisionReason ??
                decision.ask ??
                `Hook PreToolUse:${tool} asked for confirmation for this tool`,
            }
          } else if (
            item.permissionBehavior === 'allow' &&
            decision.deny === undefined &&
            decision.ask === undefined
          ) {
            decision = { allow: true }
          }
        }
        signal.throwIfAborted()
        if (stopped !== undefined) return { ...result, deny: stopped }
        if (decision.deny !== undefined)
          return { ...result, deny: decision.deny }
        if (decision.ask !== undefined) return { ...result, ask: decision.ask }
        if (decision.allow) return { ...result, allow: true }
        return result
      },
    },
  }
}
