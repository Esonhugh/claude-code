import { randomUUID } from 'crypto'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { queryModelWithoutStreaming } from '../../services/api/claude.js'
import { groupMessagesByApiRound } from '../../services/compact/grouping.js'
import { roughTokenCountEstimationForMessages } from '../../services/tokenEstimation.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { getContextWindowForModel } from '../context.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { HookResult } from '../hooks.js'
import { safeParseJSON } from '../json.js'
import { createUserMessage, extractTextContent } from '../messages.js'
import { getSmallFastModel } from '../model/model.js'
import { getTokenCountFromUsage, getTokenUsage } from '../tokens.js'
import type { PromptHook } from '../settings/types.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { addArgumentsToPrompt, hookResponseSchema } from './hookHelpers.js'

const HOOK_TRANSCRIPT_CONTEXT_FRACTION = 0.5

function getLastApiTokenCount(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type === 'assistant' && !message.isApiErrorMessage) {
      const usage = getTokenUsage(message)
      if (usage) return getTokenCountFromUsage(usage)
    }
  }
  return 0
}

function truncateHookTranscript(
  messages: Message[],
  model: string,
  contextFraction = HOOK_TRANSCRIPT_CONTEXT_FRACTION,
  force = false,
): Message[] {
  const budget = Math.floor(getContextWindowForModel(model) * contextFraction)
  if (!force && getLastApiTokenCount(messages) <= budget) return messages

  const groups = groupMessagesByApiRound(messages)
  let keptTokens = 0
  let firstKeptGroup = groups.length

  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!
    const groupTokens = roughTokenCountEstimationForMessages(
      group.map((message) => ({
        type: message.type,
        ...(message.type === 'assistant' || message.type === 'user'
          ? { message: { content: message.message.content } }
          : {}),
        ...(message.type === 'attachment'
          ? { attachment: message.attachment }
          : {}),
      })),
    )
    if (firstKeptGroup < groups.length && keptTokens + groupTokens > budget) {
      break
    }
    keptTokens += groupTokens
    firstKeptGroup = index
  }

  const kept = groups.slice(firstKeptGroup).flat()
  const droppedGroups = firstKeptGroup
  if (droppedGroups <= 0) return messages

  logForDebugging(
    `Hooks: truncated Stop transcript ${messages.length}→${kept.length} msgs (budget ${budget}, model ${model})`,
  )
  return [
    createUserMessage({
      content: `[Earlier conversation truncated to fit the hook evaluator's context window — ${droppedGroups} earlier API ${droppedGroups === 1 ? 'round' : 'rounds'} omitted. Evaluate the condition against the recent transcript below; if the required evidence may be in the omitted prefix, return {"ok": false, "reason": "insufficient evidence in transcript"}.]`,
      isMeta: true,
    }),
    ...kept,
  ]
}

function isPromptTooLongResponse(message: AssistantMessage): boolean {
  if (!message.isApiErrorMessage) return false
  return extractTextContent(message.message.content)
    .toLowerCase()
    .includes('prompt is too long')
}

/**
 * Execute a prompt-based hook using an LLM
 */
export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  messages?: Message[],
  toolUseID?: string,
): Promise<HookResult> {
  // Use provided toolUseID or generate a new one
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`
  const isStopHook = hookEvent === 'Stop' || hookEvent === 'SubagentStop'
  try {
    // Replace $ARGUMENTS with the JSON input
    const hookPrompt = isStopHook
      ? `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.\n\nCondition: ${hook.prompt}`
      : hook.prompt
    const processedPrompt = addArgumentsToPrompt(hookPrompt, jsonInput)
    logForDebugging(
      `Hooks: Processing prompt hook with prompt: ${processedPrompt}`,
    )

    // Create user message directly - no need for processUserInput which would
    // trigger UserPromptSubmit hooks and cause infinite recursion
    const userMessage = createUserMessage({ content: processedPrompt })

    const evaluatorModel = hook.model ?? getSmallFastModel()
    const buildMessages = (
      contextFraction?: number,
      forceTruncation = false,
    ): Message[] => {
      if (!messages || messages.length === 0) return [userMessage]
      return [
        ...truncateHookTranscript(
          messages,
          evaluatorModel,
          contextFraction,
          forceTruncation,
        ),
        userMessage,
      ]
    }
    let messagesToQuery = buildMessages()

    logForDebugging(
      `Hooks: Querying model with ${messagesToQuery.length} messages`,
    )

    // Query the model with Haiku
    const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 30000

    // Combined signal: aborts if either the hook signal or timeout triggers
    const { signal: combinedSignal, cleanup: cleanupSignal } =
      createCombinedAbortSignal(signal, { timeoutMs: hookTimeoutMs })

    try {
      const queryEvaluator = (queryMessages: Message[]) =>
        queryModelWithoutStreaming({
          messages: queryMessages,
          systemPrompt: asSystemPrompt([
            isStopHook
              ? `You are evaluating a stop-condition hook in Claude Code. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`
              : `You are evaluating a hook condition in Claude Code. Judge whether the user-provided condition is met.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<reason the condition is met>"}
- {"ok": false, "reason": "<reason the condition is not met>"}

Always include a "reason" field.`,
          ]),
          thinkingConfig: { type: 'disabled' as const },
          tools: [],
          signal: combinedSignal,
          options: {
            async getToolPermissionContext() {
              const appState = toolUseContext.getAppState()
              return appState.toolPermissionContext
            },
            model: evaluatorModel,
            toolChoice: undefined,
            isNonInteractiveSession: true,
            hasAppendSystemPrompt: false,
            agents: [],
            querySource: 'hook_prompt',
            mcpTools: [],
            agentId: toolUseContext.agentId,
            outputFormat: {
              type: 'json_schema',
              schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  reason: { type: 'string' },
                  impossible: { type: 'boolean' },
                },
                required: ['ok', 'reason'],
                additionalProperties: false,
              },
            },
          },
        })

      let response = await queryEvaluator(messagesToQuery)
      if (isPromptTooLongResponse(response) && messages?.length) {
        messagesToQuery = buildMessages(
          HOOK_TRANSCRIPT_CONTEXT_FRACTION / 2,
          true,
        )
        logForDebugging(
          `Hooks: evaluator prompt too long; retrying with ${messagesToQuery.length} messages`,
        )
        response = await queryEvaluator(messagesToQuery)
      }

      cleanupSignal()

      if (response.isApiErrorMessage) {
        const apiError = extractTextContent(response.message.content).trim()
        logForDebugging(`Hooks: prompt-hook evaluator API error: ${apiError}`, {
          level: 'error',
        })
        return {
          hook,
          outcome: 'non_blocking_error',
          // @ts-ignore - recovered code
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: `Hook evaluator API error: ${apiError}`,
            stdout: '',
            exitCode: 1,
          }),
        }
      }

      // Extract text content from response
      const content = extractTextContent(response.message.content)

      // Update response length for spinner display
      toolUseContext.setResponseLength((length) => length + content.length)

      const fullResponse = content.trim()
      logForDebugging(`Hooks: Model response: ${fullResponse}`)

      const json = safeParseJSON(fullResponse)
      if (!json) {
        logForDebugging(
          `Hooks: error parsing response as JSON: ${fullResponse}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          // @ts-ignore - recovered code
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: 'JSON validation failed',
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      const parsed = hookResponseSchema().safeParse(json)
      if (!parsed.success) {
        logForDebugging(
          `Hooks: model response does not conform to expected schema: ${parsed.error.message}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          // @ts-ignore - recovered code
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: `Schema validation failed: ${parsed.error.message}`,
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      // Failed to meet condition
      if (!parsed.data.ok) {
        if (parsed.data.impossible === true && isStopHook) {
          logForDebugging(
            `Hooks: Prompt hook condition judged impossible: ${parsed.data.reason}`,
          )
          return {
            hook,
            outcome: 'success',
            impossible: true,
            stopReason: parsed.data.reason,
            // @ts-ignore - recovered code
            message: createAttachmentMessage({
              type: 'hook_success',
              hookName,
              toolUseID: effectiveToolUseID,
              hookEvent,
              content: '',
            }),
          }
        }

        logForDebugging(
          `Hooks: Prompt hook condition was not met: ${parsed.data.reason}`,
        )
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: `[${hook.prompt}]: ${parsed.data.reason}`,
            command: hook.prompt,
          },
          preventContinuation: !isStopHook && hook.continueOnBlock !== true,
          stopReason: parsed.data.reason,
        }
      }

      // Condition was met
      logForDebugging(
        `Hooks: Prompt hook condition was met: ${parsed.data.reason}`,
      )
      return {
        hook,
        outcome: 'success',
        stopReason: parsed.data.reason,
        // @ts-ignore - recovered code
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: '',
        }),
      }
    } catch (error) {
      cleanupSignal()

      if (combinedSignal.aborted) {
        return {
          hook,
          outcome: 'cancelled',
        }
      }
      throw error
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: Prompt hook error: ${errorMsg}`)
    return {
      hook,
      outcome: 'non_blocking_error',
      // @ts-ignore - recovered code
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `Error executing prompt hook: ${errorMsg}`,
        stdout: '',
        exitCode: 1,
      }),
    }
  }
}
