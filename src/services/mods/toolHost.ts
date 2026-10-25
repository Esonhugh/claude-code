import { randomUUID } from 'node:crypto'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { findToolByName, type ToolUseContext } from '../../Tool.js'
import { createAssistantMessage, createUserMessage, getLastAssistantMessage } from '../../utils/messages.js'
import { createAbortController } from '../../utils/abortController.js'
import { logForDebugging } from '../../utils/debug.js'
import type { EffortValue } from '../../utils/effort.js'
import { AgentPreconditionError } from '../../utils/subagentConcurrency.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { WORKFLOW_TOOL_NAME } from '../../tools/WorkflowTool/constants.js'
import type { ModSnapshot } from './runtime.js'
import type { ToolCallResult } from './toolAdapter.js'
import type { ModInput } from './types.js'

const authorCallRefusals = new Map([
  [AGENT_TOOL_NAME, 'runs the Agent tool: that is $.agent.spawn'],
  [ASK_USER_QUESTION_TOOL_NAME, 'runs the AskUserQuestion tool: that is $.ui.ask'],
  [WORKFLOW_TOOL_NAME, 'runs the Workflow tool, whose agents run outside the at-once bound on spawns: $.agent.spawn is the door'],
])

export function createModToolHost(context: ToolUseContext, canUseTool: CanUseToolFn) {
  const getTools = () => context.mods?.tools.projection(context.options.tools) ?? context.options.tools
  return {
    tools: getTools,
    async spawn(input: ModInput, snapshot: ModSnapshot, signal: AbortSignal, spawnedBy?: string, leftRunning?: (agentId: string) => void) {
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
        const started = Promise.withResolvers<{ model: string; agentId: string; teammateId?: string }>()
        const parentMessage = getLastAssistantMessage(context.messages)
        const completion = AgentTool.call({
          prompt,
          description: (input.description as string | undefined) ?? prompt.split(/\s+/).slice(0, 5).join(' '),
          ...(input.subagentType === undefined ? {} : { subagent_type: input.subagentType as string }),
          ...(input.model === undefined ? {} : { model: input.model as string }),
          ...(input.effort === undefined ? {} : { effort: input.effort as EffortValue }),
          ...(input.name === undefined ? {} : { name: input.name as string }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd as string }),
          run_in_background: true,
        }, {
          ...context,
          innerCall: true,
          toolUseId: randomUUID(),
          modsSnapshot: snapshot,
          modSpawnedBy: spawnedBy,
          modAgentStarted: launch => {
            let claimedTaskId: string | undefined
            const setTasks = context.setAppStateForTasks ?? context.setAppState
            setTasks(prev => {
              const task = Object.values(prev.tasks).find(task => task.type === 'local_agent' && task.agentId === launch.agentId)
              if (!task || task.notified) return prev
              claimedTaskId = task.id
              return { ...prev, tasks: { ...prev.tasks, [task.id]: { ...task, notified: true } } }
            })
            if (claimedTaskId) logForDebugging(`[ModsAgent] claimed completion notification taskId=${claimedTaskId} agentId=${launch.agentId} plugin=${spawnedBy ?? 'unknown'}`)
            started.resolve(launch)
          },
          abortController,
        }, canUseTool, parentMessage)
        void completion.catch(started.reject)
        const launch = await started.promise
        if (leftRunning) {
          const { data } = await completion
          if (data.status === 'async_launched' && typeof data.agentId === 'string') leftRunning(data.agentId)
        }
        return launch
      } catch (error) {
        if (error instanceof AgentPreconditionError) return { deny: error.message }
        throw error
      } finally {
        for (const parent of parents) parent.removeEventListener('abort', abort)
      }
    },
    /** `person` marks a call the person raised themselves (a press or answer); only then does `consent` speak for them. */
    async call(input: ModInput, snapshot: ModSnapshot, signal: AbortSignal, spawnedBy?: string, entry?: 'ui.ask', person?: boolean): Promise<ToolCallResult> {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
        typeof input.tool !== 'string' || !input.tool.trim() ||
        (input.consent !== undefined && typeof input.consent !== 'string'))
        throw new TypeError('tool.call requires a tool name and optional string consent')
      const { tool: name, tool_use_id: _id, agentId: _agent, consent: offered, ...args } = input
      const consent = person === true ? offered : undefined
      if (offered !== undefined && consent === undefined)
        logForDebugging(`[ModsTool] author=${spawnedBy ?? 'unknown'} tool=${name} dropped consent: the call did not come from the person`)
      const tools = getTools()
      const tool = findToolByName(tools, name)
      const refusal = authorCallRefusals.get(tool?.name ?? name)
      if (refusal && !(entry === 'ui.ask' && tool?.name === ASK_USER_QUESTION_TOOL_NAME)) throw new Error(`${spawnedBy ? `${spawnedBy}: ` : ''}tool.call: ${refusal} (host check)`)
      if (!tool) {
        logForDebugging(`[ModsTool] author=${spawnedBy ?? 'unknown'} tool=${name} operation=call outcome=unavailable`)
        throw Object.assign(new Error(`${spawnedBy === undefined ? '' : spawnedBy + ': '}$.tool.call: no tool named "${name}" in this session`), { name: 'HooksError' })
      }
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
        const started = Date.now()
        logForDebugging(`[ModsTool] author=${spawnedBy ?? 'unknown'} tool=${tool.name} inputKeys=${Object.keys(args).join(',')}`)
        let found = false
        let result: unknown
        let text = ''
        let isError = false
        let denied = false
        for await (const update of runToolUse(block, assistant, canUseTool, {
          ...context,
          options: { ...context.options, tools },
          abortController,
          agentId: undefined,
          modSpawnedBy: spawnedBy,
          messages: consent === undefined ? [...context.messages] : [...context.messages, createUserMessage({ content: consent as string })],
          modsSnapshot: snapshot,
          // Keep the author execution wrapper, but project its final messages.
          modToolCallResult: () => {},
        })) {
          abortController.signal.throwIfAborted()
          const message = update.message
          if (message.type === 'user' && Array.isArray(message.message.content)) {
            for (const item of message.message.content) {
              if (item.type !== 'tool_result' || item.tool_use_id !== block.id) continue
              found = true
              text = typeof item.content === 'string' ? item.content :
                Array.isArray(item.content) ? item.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : ''
              isError = item.is_error === true
              denied = message.toolDenialKind !== undefined
            }
            if (message.toolUseResult !== undefined && result === undefined)
              result = message.toolUseResult
          }
        }
        abortController.signal.throwIfAborted()
        if (!found) throw new Error('tool.call produced no result')
        logForDebugging(`[ModsTool] author=${spawnedBy ?? 'unknown'} tool=${tool.name} outcome=${denied ? 'deny' : isError ? 'error' : 'result'} characters=${text.length} durationMs=${Date.now() - started}`)
        // Official author calls expose the final tool message. References,
        // read-only observations and model-only reminders stay in middleware.
        if (denied) return { deny: text.replace(/^<tool_use_error>|<\/tool_use_error>$/g, '') }
        return { result, text, ...(isError ? { isError: true as const } : {}) }
      } finally {
        for (const parent of parents) parent.removeEventListener('abort', abort)
      }
    },
    async check(input: { tool: string; input: unknown }, signal: AbortSignal, author?: string) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
        typeof input.tool !== 'string' || !input.tool.trim() ||
        !Object.hasOwn(input, 'input'))
        throw new TypeError('tool.check requires tool and input')
      signal.throwIfAborted()
      const tools = getTools()
      const tool = findToolByName(tools, input.tool)
      if (!tool) {
        logForDebugging(`[ModsTool] author=${author ?? 'unknown'} tool=${input.tool} operation=check outcome=unavailable`)
        throw Object.assign(new Error(`${author === undefined ? '' : author + ': '}$.tool.check: no tool named "${input.tool}" in this session`), { name: 'HooksError' })
      }
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
        return modToolCheckResult(result, undefined, context.getAppState().toolPermissionContext)
      } finally {
        for (const parent of parents) parent.removeEventListener('abort', abort)
      }
    },
  }
}
