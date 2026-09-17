import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import type z from 'zod/v4'
import { isDeepStrictEqual } from 'node:util'
import { Stream } from '../../utils/stream.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  createModClassicAdapter,
  type ClassicPreToolUseResult,
  type ClassicResult,
} from '../mods/classicAdapter.js'
import type { ModInput } from '../mods/types.js'
import { createToolCatalogForContext } from '../mods/toolCatalog.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AnyObject, Tool, ToolUseContext } from '../../Tool.js'
import type { HookProgress } from '../../types/hooks.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  ProgressMessage,
} from '../../types/message.js'
import type { PermissionDecision } from '../../types/permissions.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  type AggregatedHookResult,
  type HookSourceScope,
  createBaseHookInput,
  executePostToolHooks,
  executePostToolUseFailureHooks,
  executePreToolHooks,
  getPreToolHookBlockingMessage,
} from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import {
  getRuleBehaviorDescription,
  type PermissionDecisionReason,
  type PermissionResult,
} from '../../utils/permissions/PermissionResult.js'
import { checkRuleBasedPermissions } from '../../utils/permissions/permissions.js'
import { formatError } from '../../utils/toolErrors.js'
import { isMcpTool } from '../mcp/utils.js'
import type { McpServerType, MessageUpdateLazy } from './toolExecution.js'

type ClassicToolEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
type ClassicToolResult = ClassicResult &
  Pick<ClassicPreToolUseResult, 'allow' | 'ask' | 'deny' | 'updatedInput'>

/** Invocation-local managed Pre pass; never stored in a tool/agent context. */
export type ManagedPreToolUsePass = {
  input?: ModInput
  result?: ClassicToolResult
  observations?: AggregatedHookResult[]
}

/** Bridge one existing executor boundary; raw observations never inject contexts. */
async function* runClassicToolHooks(
  context: ToolUseContext,
  tool: Tool,
  event: ClassicToolEvent,
  input: ModInput,
  fallback: (sourceScope?: HookSourceScope) => AsyncIterable<AggregatedHookResult>,
  sourceScope: HookSourceScope = 'all',
  managedPass?: ManagedPreToolUsePass,
): AsyncGenerator<AggregatedHookResult> {
  if (sourceScope === 'managed' && event !== 'PreToolUse') {
    yield* fallback('managed')
    return
  }
  const ownedSnapshot = context.modsSnapshot
    ? undefined
    : context.mods?.capture({ toolCatalog: () => createToolCatalogForContext(context) })
  const snapshot = context.modsSnapshot ?? ownedSnapshot
  if (!snapshot) {
    yield* fallback(sourceScope)
    return
  }
  const stream = new Stream<AggregatedHookResult>()
  const observations: AggregatedHookResult[] = []
  const pending: Promise<unknown>[] = []
  const signal = context.abortController.signal
  const callClassic = (sourceScope: HookSourceScope, value: ModInput) => {
    const classic = createModClassicAdapter({
      sourceScope,
      getToolUseContext: () => context,
      getSessionId,
      getMessages: () => context.messages,
      getToolUseID: () => String(input.tool_use_id),
      onHookResult: (_name, result) => {
        observations.push(result)
        // Progress and diagnostics retain their identity. Decisions/contexts are
        // consumed only through the folded answer; Pre's stop is host-only.
        if (
          result.message ||
          (event === 'PreToolUse' && result.preventContinuation)
        ) {
          stream.enqueue({
            message: result.message,
            hook: result.hook,
            hookSource: result.hookSource,
            impossible: result.impossible,
            ...(event === 'PreToolUse' && result.preventContinuation
              ? { preventContinuation: true, stopReason: result.stopReason }
              : {}),
          })
        }
      },
    }).classic
    if (event === 'PreToolUse')
      return classic.PreToolUse(
        value as Parameters<typeof classic.PreToolUse>[0],
      )
    if (event === 'PostToolUse')
      return classic.PostToolUse(
        value as Parameters<typeof classic.PostToolUse>[0],
      )
    return classic.PostToolUseFailure(
      value as Parameters<typeof classic.PostToolUseFailure>[0],
    )
  }
  function validateInput(value: ModInput) {
    const pinned =
      event === 'PreToolUse'
        ? ['tool', 'tool_use_id']
        : [
            'hook_event_name',
            'tool_name',
            'tool_use_id',
            'session_id',
            'transcript_path',
            'cwd',
            'permission_mode',
            'agent_id',
            'agent_type',
          ]
    for (const key of pinned) {
      if (!isDeepStrictEqual(value[key], input[key]))
        throw new Error(`classic.${event} cannot rewrite ${key}`)
    }
  }
  function validateResult(value: unknown): asserts value is ClassicToolResult {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`classic.${event} must return an object`)
    const result = value as ClassicToolResult
    for (const key of event === 'PreToolUse'
      ? (['deny', 'ask'] as const)
      : (['block', 'stopReason'] as const)) {
      if (result[key] !== undefined && typeof result[key] !== 'string')
        throw new Error(`classic.${event} ${key} must be a string`)
    }
    if (
      result.additionalContext !== undefined &&
      (!Array.isArray(result.additionalContext) ||
        result.additionalContext.some(item => typeof item !== 'string'))
    )
      throw new Error(`classic.${event} additionalContext must contain strings`)
    if (event === 'PreToolUse') {
      if (result.allow !== undefined && result.allow !== true)
        throw new Error('classic.PreToolUse allow must be true')
      if (
        [result.allow, result.ask, result.deny].filter(
          value => value !== undefined,
        ).length > 1
      )
        throw new Error(
          'classic.PreToolUse must return at most one permission decision',
        )
      if (
        result.updatedInput !== undefined &&
        (!result.updatedInput ||
          typeof result.updatedInput !== 'object' ||
          Array.isArray(result.updatedInput))
      )
        throw new Error('classic.PreToolUse updatedInput must be an object')
      if (result.updatedInput !== undefined)
        tool.inputSchema.parse(result.updatedInput)
    } else if (
      result.preventContinuation !== undefined &&
      result.preventContinuation !== true
    ) {
      throw new Error(`classic.${event} preventContinuation must be true`)
    }
  }
  const execution = (async () => {
    try {
      const reused = event === 'PreToolUse' && managedPass?.result !== undefined &&
        isDeepStrictEqual(managedPass.input, input)
      const managed: ClassicToolResult = sourceScope === 'non-managed'
        ? {}
        : reused ? managedPass!.result! : await callClassic('managed', input)
      if (reused) observations.push(...(managedPass!.observations ?? []))
      if (event === 'PreToolUse' && sourceScope === 'managed' && managedPass && !reused) {
        managedPass.input = managed.updatedInput === undefined ? input : {
          ...managed.updatedInput, tool: input.tool, tool_use_id: input.tool_use_id,
        }
        managedPass.result = managed
        managedPass.observations = [...observations]
      }
      const managedObservationCount = observations.length
      const passedInput = event === 'PreToolUse' && managed.updatedInput !== undefined
        ? { ...managed.updatedInput, tool: input.tool, tool_use_id: input.tool_use_id }
        : input
      let answer = { ...managed }
      const blocked =
        event === 'PreToolUse'
          ? managed.deny !== undefined
          : managed.block !== undefined || managed.preventContinuation
      if (!blocked && sourceScope !== 'managed') {
        const downstream = await snapshot.dispatch(
          `classic.${event}`,
          passedInput,
          value => {
            validateInput(value)
            const run = callClassic(
              event === 'PreToolUse' && !isDeepStrictEqual(value, passedInput)
                ? 'all' : 'non-managed',
              value,
            )
            pending.push(run)
            return run
          },
          { signal, validateInput, validateResult },
        )
        validateResult(downstream)
        answer = { ...managed, ...downstream }
        if (managed.additionalContext || downstream.additionalContext)
          answer.additionalContext = [
            ...(managed.additionalContext ?? []),
            ...(downstream.additionalContext ?? []),
          ]
        if (event === 'PreToolUse') {
          delete answer.allow
          delete answer.ask
          delete answer.deny
          if (downstream.deny !== undefined) answer.deny = downstream.deny
          else if (managed.ask !== undefined || downstream.ask !== undefined)
            answer.ask = managed.ask ?? downstream.ask
          else {
            const { tool: _tool, tool_use_id: _id, ...passedArgs } = passedInput
            const changed = downstream.updatedInput !== undefined &&
              !isDeepStrictEqual(downstream.updatedInput, passedArgs)
            if (downstream.allow || (managed.allow && !changed)) answer.allow = true
          }
        }
      }
      await Promise.allSettled(pending)
      signal.throwIfAborted()
      if (
        event === 'PreToolUse' &&
        answer.deny === undefined &&
        answer.updatedInput !== undefined
      ) {
        const parsed = tool.inputSchema.parse(answer.updatedInput)
        const validation = await tool.validateInput?.(parsed, context)
        if (validation?.result === false)
          throw new Error(
            validation.message ?? 'Invalid classic.PreToolUse updatedInput',
          )
        answer.updatedInput = parsed
      }
      const folded: AggregatedHookResult = {
        additionalContexts: answer.additionalContext,
      }
      if (event === 'PreToolUse') {
        const stopped = observations.findLast(item => item.preventContinuation)
        if (stopped) {
          delete answer.allow
          delete answer.ask
          answer.deny =
            stopped.stopReason ?? 'Execution stopped by PreToolUse hook'
        }
        folded.permissionBehavior =
          answer.deny !== undefined
            ? 'deny'
            : answer.ask !== undefined
              ? 'ask'
              : answer.allow
                ? 'allow'
                : undefined
        folded.hookPermissionDecisionReason = answer.deny ?? answer.ask
        folded.updatedInput = answer.updatedInput
        const managedWins =
          blocked ||
          (folded.permissionBehavior === 'ask' && managed.ask !== undefined) ||
          (folded.permissionBehavior === 'allow' && managed.allow === true)
        const decisionObservations = managedWins
          ? observations.slice(0, managedObservationCount)
          : observations.slice(managedObservationCount)
        const origin =
          decisionObservations.findLast(
            item =>
              item.permissionBehavior === folded.permissionBehavior &&
              (folded.permissionBehavior === 'allow' ||
                item.hookPermissionDecisionReason ===
                  folded.hookPermissionDecisionReason),
          ) ??
          decisionObservations.findLast(
            item =>
              item.blockingError?.blockingError === answer.deny &&
              answer.deny !== undefined,
          )
        folded.hookSource = stopped?.hookSource ?? origin?.hookSource
      } else {
        if (answer.block !== undefined) {
          const origin = observations.findLast(
            item => item.blockingError?.blockingError === answer.block,
          )
          folded.blockingError = origin?.blockingError ?? {
            blockingError: answer.block,
            command: `classic.${event}`,
          }
          folded.hook = origin?.hook
          folded.hookSource = origin?.hookSource
          folded.impossible = origin?.impossible
        }
        folded.preventContinuation = answer.preventContinuation
        folded.stopReason = answer.stopReason
        if (event === 'PostToolUse')
          folded.updatedMCPToolOutput = answer.updatedMCPToolOutput
      }
      // Existing post wrappers stop consuming at preventContinuation; send the
      // already-folded context/output first, then that terminal control item.
      if (event !== 'PreToolUse' && folded.preventContinuation) {
        const { preventContinuation, stopReason, ...beforeStop } = folded
        stream.enqueue(beforeStop)
        stream.enqueue({ preventContinuation, stopReason })
      } else {
        stream.enqueue(folded)
      }
    } finally {
      // A module may call next without awaiting it. Keep the captured realm and
      // observer alive until those executions settle, including on cancellation.
      await Promise.allSettled(pending)
      ownedSnapshot?.release()
    }
  })()
  void execution.then(
    () => stream.done(),
    error => stream.error(error),
  )
  try {
    yield* stream
  } finally {
    await execution
  }
}

export type PostToolUseHooksResult<Output> =
  | MessageUpdateLazy<AttachmentMessage | ProgressMessage<HookProgress>>
  | { updatedMCPToolOutput: Output }

export async function* runPostToolUseHooks<Input extends AnyObject, Output>(
  toolUseContext: ToolUseContext,
  tool: Tool<Input, Output>,
  toolUseID: string,
  messageId: string,
  toolInput: Record<string, unknown>,
  toolResponse: Output,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  mcpServerBaseUrl: string | undefined,
  sourceScope: HookSourceScope = 'all',
): AsyncGenerator<PostToolUseHooksResult<Output>> {
  const postToolStartTime = Date.now()
  try {
    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode

    let toolOutput = toolResponse
    for await (const result of runClassicToolHooks(
      toolUseContext,
      tool,
      'PostToolUse',
      {
        ...createBaseHookInput(permissionMode, undefined, toolUseContext),
        hook_event_name: 'PostToolUse',
        tool_name: tool.name,
        tool_use_id: toolUseID,
        tool_input: toolInput,
        tool_response: toolOutput,
      },
      scope =>
        executePostToolHooks(
          tool.name,
          toolUseID,
          toolInput,
          toolOutput,
          toolUseContext,
          permissionMode,
          toolUseContext.abortController.signal,
          undefined,
          scope,
        ),
      sourceScope,
    )) {
      try {
        // Check if we were aborted during hook execution
        // IMPORTANT: We emit a cancelled event per hook
        if (
          // @ts-ignore - recovered code
          result.message?.type === 'attachment' &&
          // @ts-ignore - recovered code
          result.message.attachment.type === 'hook_cancelled'
        ) {
          logEvent('tengu_post_tool_hooks_cancelled', {
            toolName: sanitizeToolNameForAnalytics(tool.name),

            queryChainId: toolUseContext.queryTracking
              ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            queryDepth: toolUseContext.queryTracking?.depth,
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_cancelled',
              hookName: `PostToolUse:${tool.name}`,
              toolUseID,
              hookEvent: 'PostToolUse',
            }),
          }
          continue
        }

        // For JSON {decision:"block"} hooks, executeHooks yields two results:
        // {blockingError} and {message: hook_blocking_error attachment}. The
        // blockingError path below creates that same attachment, so skip it
        // here to avoid displaying the block reason twice (#31301). The
        // exit-code-2 path only yields {blockingError}, so it's unaffected.
        if (
          result.message &&
          !(
            (result.message as unknown as AttachmentMessage).type ===
              'attachment' &&
            (result.message as unknown as AttachmentMessage).attachment.type ===
              'hook_blocking_error'
          )
        ) {
          // @ts-ignore - recovered code
          yield { message: result.message }
        }

        if (result.blockingError) {
          yield {
            message: createAttachmentMessage({
              type: 'hook_blocking_error',
              hookName: `PostToolUse:${tool.name}`,
              toolUseID: toolUseID,
              hookEvent: 'PostToolUse',
              blockingError: result.blockingError,
            }),
          }
        }

        // If hook indicated to prevent continuation, yield a stop reason message
        if (result.preventContinuation) {
          yield {
            message: createAttachmentMessage({
              type: 'hook_stopped_continuation',
              message:
                result.stopReason || 'Execution stopped by PostToolUse hook',
              hookName: `PostToolUse:${tool.name}`,
              toolUseID: toolUseID,
              hookEvent: 'PostToolUse',
            }),
          }
          return
        }

        // If hooks provided additional context, add it as a message
        if (result.additionalContexts && result.additionalContexts.length > 0) {
          yield {
            message: createAttachmentMessage({
              type: 'hook_additional_context',
              content: result.additionalContexts,
              hookName: `PostToolUse:${tool.name}`,
              toolUseID: toolUseID,
              hookEvent: 'PostToolUse',
            }),
          }
        }

        // If hooks provided updatedMCPToolOutput, yield it if this is an MCP tool
        if (result.updatedMCPToolOutput !== undefined && isMcpTool(tool)) {
          toolOutput = result.updatedMCPToolOutput as Output
          yield {
            updatedMCPToolOutput: toolOutput,
          }
        }
      } catch (error) {
        const postToolDurationMs = Date.now() - postToolStartTime
        logEvent('tengu_post_tool_hook_error', {
          messageID:
            messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          toolName: sanitizeToolNameForAnalytics(tool.name),
          isMcp: tool.isMcp ?? false,
          duration: postToolDurationMs,

          queryChainId: toolUseContext.queryTracking
            ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: toolUseContext.queryTracking?.depth,
          ...(mcpServerType
            ? {
                mcpServerType:
                  mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
          ...(requestId
            ? {
                requestId:
                  requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
        })
        yield {
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            content: formatError(error),
            hookName: `PostToolUse:${tool.name}`,
            toolUseID: toolUseID,
            hookEvent: 'PostToolUse',
          }),
        }
      }
    }
  } catch (error) {
    logError(error)
  }
}

export async function* runPostToolUseFailureHooks<Input extends AnyObject>(
  toolUseContext: ToolUseContext,
  tool: Tool<Input, unknown>,
  toolUseID: string,
  messageId: string,
  processedInput: z.infer<Input>,
  error: string,
  isInterrupt: boolean | undefined,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  mcpServerBaseUrl: string | undefined,
  sourceScope: HookSourceScope = 'all',
): AsyncGenerator<
  MessageUpdateLazy<AttachmentMessage | ProgressMessage<HookProgress>>
> {
  const postToolStartTime = Date.now()
  try {
    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode

    for await (const result of runClassicToolHooks(
      toolUseContext,
      tool,
      'PostToolUseFailure',
      {
        ...createBaseHookInput(permissionMode, undefined, toolUseContext),
        hook_event_name: 'PostToolUseFailure',
        tool_name: tool.name,
        tool_use_id: toolUseID,
        tool_input: processedInput,
        error,
        is_interrupt: isInterrupt,
      },
      scope =>
        executePostToolUseFailureHooks(
          tool.name,
          toolUseID,
          processedInput,
          error,
          toolUseContext,
          isInterrupt,
          permissionMode,
          toolUseContext.abortController.signal,
          undefined,
          scope,
        ),
      sourceScope,
    )) {
      try {
        // Check if we were aborted during hook execution
        if (
          // @ts-ignore - recovered code
          result.message?.type === 'attachment' &&
          // @ts-ignore - recovered code
          result.message.attachment.type === 'hook_cancelled'
        ) {
          logEvent('tengu_post_tool_failure_hooks_cancelled', {
            toolName: sanitizeToolNameForAnalytics(tool.name),
            queryChainId: toolUseContext.queryTracking
              ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            queryDepth: toolUseContext.queryTracking?.depth,
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_cancelled',
              hookName: `PostToolUseFailure:${tool.name}`,
              toolUseID,
              hookEvent: 'PostToolUseFailure',
            }),
          }
          continue
        }

        // Skip hook_blocking_error in result.message — blockingError path
        // below creates the same attachment (see #31301 / PostToolUse above).
        if (
          result.message &&
          !(
            (result.message as unknown as AttachmentMessage).type ===
              'attachment' &&
            (result.message as unknown as AttachmentMessage).attachment.type ===
              'hook_blocking_error'
          )
        ) {
          // @ts-ignore - recovered code
          yield { message: result.message }
        }

        if (result.blockingError) {
          yield {
            message: createAttachmentMessage({
              type: 'hook_blocking_error',
              hookName: `PostToolUseFailure:${tool.name}`,
              toolUseID: toolUseID,
              hookEvent: 'PostToolUseFailure',
              blockingError: result.blockingError,
            }),
          }
        }

        if (
          result.preventContinuation &&
          (toolUseContext.mods || toolUseContext.modsSnapshot)
        ) {
          yield {
            message: createAttachmentMessage({
              type: 'hook_stopped_continuation',
              message:
                result.stopReason ||
                'Execution stopped by PostToolUseFailure hook',
              hookName: `PostToolUseFailure:${tool.name}`,
              toolUseID,
              hookEvent: 'PostToolUseFailure',
            }),
          }
          return
        }

        // If hooks provided additional context, add it as a message
        if (result.additionalContexts && result.additionalContexts.length > 0) {
          yield {
            message: createAttachmentMessage({
              type: 'hook_additional_context',
              content: result.additionalContexts,
              hookName: `PostToolUseFailure:${tool.name}`,
              toolUseID: toolUseID,
              hookEvent: 'PostToolUseFailure',
            }),
          }
        }
      } catch (hookError) {
        const postToolDurationMs = Date.now() - postToolStartTime
        logEvent('tengu_post_tool_failure_hook_error', {
          messageID:
            messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          toolName: sanitizeToolNameForAnalytics(tool.name),
          isMcp: tool.isMcp ?? false,
          duration: postToolDurationMs,
          queryChainId: toolUseContext.queryTracking
            ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: toolUseContext.queryTracking?.depth,
          ...(mcpServerType
            ? {
                mcpServerType:
                  mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
          ...(requestId
            ? {
                requestId:
                  requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
        })
        yield {
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            content: formatError(hookError),
            hookName: `PostToolUseFailure:${tool.name}`,
            toolUseID: toolUseID,
            hookEvent: 'PostToolUseFailure',
          }),
        }
      }
    }
  } catch (outerError) {
    logError(outerError)
  }
}

/**
 * Resolve a PreToolUse hook's permission result into a final PermissionDecision.
 *
 * Encapsulates the invariant that hook 'allow' does NOT bypass settings.json
 * deny/ask rules — checkRuleBasedPermissions still applies (inc-4788 analog).
 * Also handles the requiresUserInteraction/requireCanUseTool guards and the
 * 'ask' forceDecision passthrough.
 *
 * Shared by toolExecution.ts (main query loop) and REPLTool/toolWrappers.ts
 * (REPL inner calls) so the permission semantics stay in lockstep.
 */
export async function resolveHookPermissionDecision(
  hookPermissionResult: PermissionResult | undefined,
  tool: Tool,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  toolUseID: string,
): Promise<{
  decision: PermissionDecision
  input: Record<string, unknown>
}> {
  const requiresInteraction = tool.requiresUserInteraction?.()
  const requireCanUseTool = toolUseContext.requireCanUseTool

  if (hookPermissionResult?.behavior === 'allow') {
    const hookInput = hookPermissionResult.updatedInput ?? input

    // Hook provided updatedInput for an interactive tool — the hook IS the
    // user interaction (e.g. headless wrapper that collected AskUserQuestion
    // answers). Treat as non-interactive for the rule-check path.
    const interactionSatisfied =
      requiresInteraction && hookPermissionResult.updatedInput !== undefined

    if ((requiresInteraction && !interactionSatisfied) || requireCanUseTool) {
      logForDebugging(
        `Hook approved tool use for ${tool.name}, but canUseTool is required`,
      )
      return {
        decision: await canUseTool(
          tool,
          hookInput,
          toolUseContext,
          assistantMessage,
          toolUseID,
        ),
        input: hookInput,
      }
    }

    // Hook allow skips the interactive prompt, but deny/ask rules still apply.
    const ruleCheck = await checkRuleBasedPermissions(
      tool,
      hookInput,
      toolUseContext,
    )
    if (ruleCheck === null) {
      logForDebugging(
        interactionSatisfied
          ? `Hook satisfied user interaction for ${tool.name} via updatedInput`
          : `Hook approved tool use for ${tool.name}, bypassing permission prompt`,
      )
      return { decision: hookPermissionResult, input: hookInput }
    }
    if (ruleCheck.behavior === 'deny') {
      logForDebugging(
        `Hook approved tool use for ${tool.name}, but deny rule overrides: ${ruleCheck.message}`,
      )
      return { decision: ruleCheck, input: hookInput }
    }
    // ask rule — dialog required despite hook approval
    logForDebugging(
      `Hook approved tool use for ${tool.name}, but ask rule requires prompt`,
    )
    return {
      decision: await canUseTool(
        tool,
        hookInput,
        toolUseContext,
        assistantMessage,
        toolUseID,
      ),
      input: hookInput,
    }
  }

  if (hookPermissionResult?.behavior === 'deny') {
    logForDebugging(`Hook denied tool use for ${tool.name}`)
    return { decision: hookPermissionResult, input }
  }

  // No hook decision or 'ask' — normal permission flow, possibly with
  // forceDecision so the dialog shows the hook's ask message.
  const forceDecision =
    hookPermissionResult?.behavior === 'ask' ? hookPermissionResult : undefined
  const askInput =
    hookPermissionResult?.behavior === 'ask' &&
    hookPermissionResult.updatedInput
      ? hookPermissionResult.updatedInput
      : input
  return {
    decision: await canUseTool(
      tool,
      askInput,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ),
    input: askInput,
  }
}

export async function* runPreToolUseHooks(
  toolUseContext: ToolUseContext,
  tool: Tool,
  processedInput: Record<string, unknown>,
  toolUseID: string,
  messageId: string,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  mcpServerBaseUrl: string | undefined,
  sourceScope: HookSourceScope = 'all',
  managedPass?: ManagedPreToolUsePass,
): AsyncGenerator<
  | {
      type: 'message'
      message: MessageUpdateLazy<
        AttachmentMessage | ProgressMessage<HookProgress>
      >
    }
  | { type: 'hookPermissionResult'; hookPermissionResult: PermissionResult }
  | { type: 'hookUpdatedInput'; updatedInput: Record<string, unknown> }
  | { type: 'preventContinuation'; shouldPreventContinuation: boolean }
  | { type: 'stopReason'; stopReason: string }
  | {
      type: 'additionalContext'
      message: MessageUpdateLazy<AttachmentMessage>
    }
  // stop execution
  | { type: 'stop' }
> {
  const hookStartTime = Date.now()
  try {
    const appState = toolUseContext.getAppState()

    for await (const result of runClassicToolHooks(
      toolUseContext,
      tool,
      'PreToolUse',
      { ...processedInput, tool: tool.name, tool_use_id: toolUseID },
      scope =>
        executePreToolHooks(
          tool.name,
          toolUseID,
          processedInput,
          toolUseContext,
          appState.toolPermissionContext.mode,
          toolUseContext.abortController.signal,
          undefined, // timeoutMs - use default
          toolUseContext.requestPrompt,
          tool.getToolUseSummary?.(processedInput),
          scope,
        ),
      sourceScope,
      managedPass,
    )) {
      try {
        if (result.message) {
          // @ts-ignore - recovered code
          yield { type: 'message', message: { message: result.message } }
        }
        if (result.blockingError) {
          const denialMessage = getPreToolHookBlockingMessage(
            `PreToolUse:${tool.name}`,
            result.blockingError,
          )
          yield {
            type: 'hookPermissionResult',
            hookPermissionResult: {
              behavior: 'deny',
              message: denialMessage,
              decisionReason: {
                type: 'hook',
                hookName: `PreToolUse:${tool.name}`,
                reason: denialMessage,
              },
            },
          }
        }
        // Check if hook wants to prevent continuation
        if (result.preventContinuation) {
          yield {
            type: 'preventContinuation',
            shouldPreventContinuation: true,
          }
          if (result.stopReason) {
            yield { type: 'stopReason', stopReason: result.stopReason }
          }
        }
        // Check for hook-defined permission behavior
        if (result.permissionBehavior !== undefined) {
          logForDebugging(
            `Hook result has permissionBehavior=${result.permissionBehavior}`,
          )
          const decisionReason: PermissionDecisionReason = {
            type: 'hook',
            hookName: `PreToolUse:${tool.name}`,
            hookSource: result.hookSource,
            reason: result.hookPermissionDecisionReason,
          }
          if (result.permissionBehavior === 'allow') {
            yield {
              type: 'hookPermissionResult',
              hookPermissionResult: {
                behavior: 'allow',
                updatedInput: result.updatedInput,
                decisionReason,
              },
            }
          } else if (result.permissionBehavior === 'ask') {
            yield {
              type: 'hookPermissionResult',
              hookPermissionResult: {
                behavior: 'ask',
                updatedInput: result.updatedInput,
                message:
                  result.hookPermissionDecisionReason ||
                  `Hook PreToolUse:${tool.name} ${getRuleBehaviorDescription(result.permissionBehavior)} this tool`,
                decisionReason,
              },
            }
          } else {
            // deny - updatedInput is irrelevant since tool won't run
            yield {
              type: 'hookPermissionResult',
              hookPermissionResult: {
                behavior: result.permissionBehavior,
                message:
                  result.hookPermissionDecisionReason ||
                  `Hook PreToolUse:${tool.name} ${getRuleBehaviorDescription(result.permissionBehavior)} this tool`,
                decisionReason,
              },
            }
          }
        }

        // Yield updatedInput for passthrough case (no permission decision)
        // This allows hooks to modify input while letting normal permission flow continue
        if (result.updatedInput && result.permissionBehavior === undefined) {
          yield {
            type: 'hookUpdatedInput',
            updatedInput: result.updatedInput,
          }
        }

        // If hooks provided additional context, add it as a message
        if (result.additionalContexts && result.additionalContexts.length > 0) {
          yield {
            type: 'additionalContext',
            message: {
              message: createAttachmentMessage({
                type: 'hook_additional_context',
                content: result.additionalContexts,
                hookName: `PreToolUse:${tool.name}`,
                toolUseID,
                hookEvent: 'PreToolUse',
              }),
            },
          }
        }

        // Check if we were aborted during hook execution
        if (toolUseContext.abortController.signal.aborted) {
          logEvent('tengu_pre_tool_hooks_cancelled', {
            toolName: sanitizeToolNameForAnalytics(tool.name),

            queryChainId: toolUseContext.queryTracking
              ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            queryDepth: toolUseContext.queryTracking?.depth,
          })
          yield {
            type: 'message',
            message: {
              message: createAttachmentMessage({
                type: 'hook_cancelled',
                hookName: `PreToolUse:${tool.name}`,
                toolUseID,
                hookEvent: 'PreToolUse',
              }),
            },
          }
          yield { type: 'stop' }
          return
        }
      } catch (error) {
        logError(error)
        const durationMs = Date.now() - hookStartTime
        logEvent('tengu_pre_tool_hook_error', {
          messageID:
            messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          toolName: sanitizeToolNameForAnalytics(tool.name),
          isMcp: tool.isMcp ?? false,
          duration: durationMs,

          queryChainId: toolUseContext.queryTracking
            ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: toolUseContext.queryTracking?.depth,
          ...(mcpServerType
            ? {
                mcpServerType:
                  mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
          ...(requestId
            ? {
                requestId:
                  requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
        })
        yield {
          type: 'message',
          message: {
            message: createAttachmentMessage({
              type: 'hook_error_during_execution',
              content: formatError(error),
              hookName: `PreToolUse:${tool.name}`,
              toolUseID: toolUseID,
              hookEvent: 'PreToolUse',
            }),
          },
        }
        yield { type: 'stop' }
      }
    }
  } catch (error) {
    logError(error)
    yield { type: 'stop' }
    return
  }
}
