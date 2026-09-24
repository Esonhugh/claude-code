import { randomUUID } from 'node:crypto'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { findToolByName, type ToolUseContext } from '../../Tool.js'
import { createAssistantMessage, createUserMessage, getLastAssistantMessage } from '../../utils/messages.js'
import { createAbortController } from '../../utils/abortController.js'
import type { ModSnapshot } from './runtime.js'
import type { ToolCallResult } from './toolAdapter.js'
import type { ModInput } from './types.js'

export function createModToolHost(context: ToolUseContext, canUseTool: CanUseToolFn) {
  const getTools = () => context.mods?.tools.projection(context.options.tools) ?? context.options.tools
  return {
    tools: getTools,
    async spawn(input: ModInput, snapshot: ModSnapshot, signal: AbortSignal, spawnedBy?: string) {
      const { AgentTool } = await import('../../tools/AgentTool/AgentTool.js')
      const abortController = createAbortController()
      const parents = new Set([signal, context.abortController.signal])
      const abort = () => {
        const parent = [...parents].find(parent => parent.aborted)
        if (parent) abortController.abort(parent.reason)
      }
      for (const parent of parents) parent.addEventListener('abort', abort, { once: true })
      abort()
      try {
        abortController.signal.throwIfAborted()
        const prompt = input.prompt as string
        const started = Promise.withResolvers<{ model: string; agentId: string }>()
        const parentMessage = getLastAssistantMessage(context.messages)
        const completion = AgentTool.call({
          prompt,
          description: typeof input.description === 'string' && input.description.trim()
            ? input.description
            : prompt.replace(/\s+/g, ' ').trim().slice(0, 80),
          ...(input.subagentType === undefined ? {} : { subagent_type: input.subagentType as string }),
          ...(input.model === undefined ? {} : { model: input.model as string }),
          ...(input.name === undefined ? {} : { name: input.name as string }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd as string }),
          run_in_background: true,
        }, {
          ...context,
          toolUseId: randomUUID(),
          modsSnapshot: snapshot,
          modSpawnedBy: spawnedBy,
          modAgentStarted: started.resolve,
          abortController,
        }, canUseTool, parentMessage)
        void completion.catch(started.reject)
        return await started.promise
      } finally {
        for (const parent of parents) parent.removeEventListener('abort', abort)
      }
    },
    async call(input: ModInput, snapshot: ModSnapshot, signal: AbortSignal, spawnedBy?: string): Promise<ToolCallResult> {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
        typeof input.tool !== 'string' || !input.tool.trim() ||
        (input.consent !== undefined && typeof input.consent !== 'string'))
        throw new TypeError('tool.call requires a tool name and optional string consent')
      const { tool: name, tool_use_id: _id, agentId: _agent, consent, ...args } = input
      const tools = getTools()
      const tool = findToolByName(tools, name)
      if (!tool) throw new Error(`No such tool available: ${name}`)
      const block = { type: 'tool_use' as const, caller: { type: 'direct' as const }, id: randomUUID(), name: tool.name, input: args }
      const assistant = createAssistantMessage({ content: [block] })
      // The executor's tools include query/Agent, which bind this host themselves.
      const { runToolUse } = await import('../tools/toolExecution.js')
      const abortController = createAbortController()
      const parents = new Set([signal, context.abortController.signal])
      const abort = () => {
        const parent = [...parents].find(parent => parent.aborted)
        if (parent) abortController.abort(parent.reason)
      }
      for (const parent of parents) parent.addEventListener('abort', abort, { once: true })
      abort()
      try {
        abortController.signal.throwIfAborted()
        let result: ToolCallResult | undefined
        let coreResult: ToolCallResult | undefined
        for await (const update of runToolUse(block, assistant, canUseTool, {
          ...context,
          options: { ...context.options, tools },
          abortController,
          agentId: undefined,
          modSpawnedBy: spawnedBy,
          messages: consent === undefined ? [...context.messages] : [...context.messages, createUserMessage({ content: consent as string })],
          modsSnapshot: snapshot,
          modToolCallResult: value => { result = value },
        })) {
          abortController.signal.throwIfAborted()
          const message = update.message
          if (message.type === 'user' && Array.isArray(message.message.content)) {
            for (const item of message.message.content) {
              if (item.type !== 'tool_result' || item.tool_use_id !== block.id) continue
              coreResult = {
                ref: 1,
                result: message.toolUseResult,
                text: typeof item.content === 'string' ? item.content :
                  Array.isArray(item.content) ? item.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '',
                ...(item.is_error ? { isError: true } : {}),
              }
            }
          }
        }
        abortController.signal.throwIfAborted()
        // Managed Pre vetoes and executor catch paths can finish before dispatch.
        result = coreResult?.isError && result?.deny === undefined && !result?.isError
          ? coreResult : result ?? coreResult
        if (!result) throw new Error('tool.call produced no result')
        return result
      } finally {
        for (const parent of parents) parent.removeEventListener('abort', abort)
      }
    },
    async check(input: { tool: string; input: unknown }, signal: AbortSignal) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
        typeof input.tool !== 'string' || !input.tool.trim() ||
        !Object.hasOwn(input, 'input'))
        throw new TypeError('tool.check requires tool and input')
      signal.throwIfAborted()
      const tools = getTools()
      const tool = findToolByName(tools, input.tool)
      if (!tool) throw new Error(`No such tool available: ${input.tool}`)
      const args = tool.inputSchema.parse(input.input)
      const { checkModToolPermission, modToolCheckResult } = await import('../tools/toolHooks.js')
      const abortController = createAbortController()
      const parents = new Set([signal, context.abortController.signal])
      const abort = () => {
        const parent = [...parents].find(parent => parent.aborted)
        if (parent) abortController.abort(parent.reason)
      }
      for (const parent of parents) parent.addEventListener('abort', abort, { once: true })
      abort()
      try {
        const result = await checkModToolPermission(tool, args, { ...context, options: { ...context.options, tools }, agentId: undefined, abortController })
        abortController.signal.throwIfAborted()
        return modToolCheckResult(result)
      } finally {
        for (const parent of parents) parent.removeEventListener('abort', abort)
      }
    },
  }
}
