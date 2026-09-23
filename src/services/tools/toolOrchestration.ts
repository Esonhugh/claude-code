import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { findToolByName, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { all } from '../../utils/generators.js'
import { type MessageUpdateLazy, runToolUse } from './toolExecution.js'
import { createToolCatalogForContext } from '../mods/toolCatalog.js'
import { captureModSessionUsage } from '../mods/sessionUsage.js'

function getMaxToolUseConcurrency(): number {
  return (
    parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
  )
}

export type MessageUpdate = {
  message?: Message
  newContext: ToolUseContext
}

export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext
  const usageContext = {
    ...toolUseContext,
    messages: [...toolUseContext.messages, ...assistantMessages],
  }
  const snapshot = toolUseContext.mods?.capture({
    toolCatalog: () => createToolCatalogForContext(currentContext),
    captureUsage: () => captureModSessionUsage(usageContext),
  })
  if (snapshot) currentContext = { ...currentContext, modsSnapshot: snapshot }
  try {
    for (const { isConcurrencySafe, blocks } of partitionToolCalls(
      toolUseMessages,
      currentContext,
    )) {
      if (isConcurrencySafe) {
        const queuedContextModifiers: Record<
          string,
          ((context: ToolUseContext) => ToolUseContext)[]
        > = {}
        // Run read-only batch concurrently
        for await (const update of runToolsConcurrently(
          blocks,
          assistantMessages,
          canUseTool,
          currentContext,
        )) {
          if (update.contextModifier) {
            const { toolUseID, modifyContext } = update.contextModifier
            if (!queuedContextModifiers[toolUseID]) {
              queuedContextModifiers[toolUseID] = []
            }
            queuedContextModifiers[toolUseID].push(modifyContext)
          }
          yield {
            message: update.message,
            newContext: snapshot
              ? { ...currentContext, modsSnapshot: toolUseContext.modsSnapshot }
              : currentContext,
          }
        }
        for (const block of blocks) {
          const modifiers = queuedContextModifiers[block.id]
          if (!modifiers) {
            continue
          }
          for (const modifier of modifiers) {
            currentContext = modifier(currentContext)
            if (snapshot)
              currentContext = { ...currentContext, modsSnapshot: snapshot }
          }
        }
        yield {
          newContext: snapshot
            ? { ...currentContext, modsSnapshot: toolUseContext.modsSnapshot }
            : currentContext,
        }
      } else {
        // Run non-read-only batch serially
        for await (const update of runToolsSerially(
          blocks,
          assistantMessages,
          canUseTool,
          currentContext,
        )) {
          if (update.newContext) {
            currentContext = update.newContext
          }
          yield {
            message: update.message,
            newContext: snapshot
              ? { ...currentContext, modsSnapshot: toolUseContext.modsSnapshot }
              : currentContext,
          }
        }
      }
    }
  } finally {
    snapshot?.release()
  }
}

type Batch = { isConcurrencySafe: boolean; blocks: ToolUseBlock[] }

/**
 * Partition tool calls into batches where each batch is either:
 * 1. A single non-read-only tool, or
 * 2. Multiple consecutive read-only tools
 */
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  if (toolUseContext.modsSnapshot?.hasHooks('tool.call')) {
    return toolUseMessages.map(block => ({
      isConcurrencySafe: false,
      blocks: [block],
    }))
  }
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            // If isConcurrencySafe throws (e.g., due to shell-quote parse failure),
            // treat as not concurrency-safe to be conservative
            return false
          }
        })()
      : false
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}

async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext

  for (const toolUse of toolUseMessages) {
    toolUseContext.setInProgressToolUseIDs(prev =>
      new Set(prev).add(toolUse.id),
    )
    for await (const update of runToolUse(
      toolUse,
      assistantMessages.find(_ =>
        _.message.content.some(
          _ => _.type === 'tool_use' && _.id === toolUse.id,
        ),
      )!,
      canUseTool,
      currentContext,
    )) {
      if (update.contextModifier) {
        currentContext = update.contextModifier.modifyContext(currentContext)
        if (toolUseContext.modsSnapshot)
          currentContext = {
            ...currentContext,
            modsSnapshot: toolUseContext.modsSnapshot,
          }
      }
      yield {
        message: update.message,
        newContext: currentContext,
      }
    }
    markToolUseAsComplete(toolUseContext, toolUse.id)
  }
}

async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  const running = new Set<AsyncGenerator<MessageUpdateLazy, void>>()
  const generators = toolUseMessages.map(async function* (toolUse) {
    toolUseContext.setInProgressToolUseIDs(prev =>
      new Set(prev).add(toolUse.id),
    )
    const generator = runToolUse(
      toolUse,
      assistantMessages.find(_ =>
        _.message.content.some(
          _ => _.type === 'tool_use' && _.id === toolUse.id,
        ),
      )!,
      canUseTool,
      toolUseContext,
    )
    running.add(generator)
    try {
      yield* generator
    } finally {
      running.delete(generator)
      markToolUseAsComplete(toolUseContext, toolUse.id)
    }
  })
  try {
    yield* all(generators, getMaxToolUseConcurrency())
  } finally {
    if (toolUseContext.modsSnapshot)
      await Promise.allSettled(
        [...running].map(generator => generator.return()),
      )
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
