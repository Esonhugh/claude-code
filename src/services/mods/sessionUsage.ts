import { z } from 'zod'
import { collectContextData } from '../../commands/context/context-noninteractive.js'
import { getTotalCost } from '../../cost-tracker.js'
import { getRawUtilization } from '../claudeAiLimits.js'
import { calculateContextPercentages, getContextWindowForModel } from '../../utils/context.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { getRuntimeMainLoopModel } from '../../utils/model/model.js'
import { doesMostRecentAssistantMessageExceed200k, getCurrentUsage } from '../../utils/tokens.js'

const number = z.number().finite()
const tokens = number.nonnegative()
const usageArgs = z.object({
  breakdown:z.enum(['summary','full']).optional(),
  columns:number.optional(),
})
const apiUsage = z.object({
  input_tokens:tokens, output_tokens:tokens,
  cache_creation_input_tokens:tokens, cache_read_input_tokens:tokens,
})
const listing = z.object({totalCommands:tokens,includedCommands:tokens,tokens})
const breakdown = z.object({
  categories:z.array(z.object({
    name:z.string(),tokens,color:z.string(),isDeferred:z.boolean(),
    kind:z.enum(['used','free','buffer','deferred']),
  })),
  totalTokens:tokens,maxTokens:tokens,rawMaxTokens:tokens,
  autocompactSource:z.enum(['env','settings','clientdata','experiment','model-default','unknown-model','auto']),
  percentage:number,
  gridRows:z.array(z.array(z.object({
    color:z.string(),isFilled:z.boolean(),categoryName:z.string(),tokens,
    percentage:number,squareFullness:number.min(0).max(1),
  }))),
  model:z.string(),
  memoryFiles:z.array(z.object({path:z.string(),type:z.string(),tokens})),
  mcpTools:z.array(z.object({name:z.string(),serverName:z.string(),tokens,isLoaded:z.boolean()})),
  agents:z.array(z.object({agentType:z.string(),source:z.string(),tokens})),
  slashCommands:listing.optional(),
  skills:z.object({
    totalSkills:tokens,includedSkills:tokens,tokens,
    skillFrontmatter:z.array(z.object({name:z.string(),source:z.string(),pluginName:z.string().optional(),tokens})),
  }).optional(),
  autoCompactThreshold:tokens.optional(),isAutoCompactEnabled:z.boolean(),
  apiUsage:apiUsage.nullable(),
})
const usage = z.object({
  context:z.object({window:tokens,tokens:tokens.optional(),percent:number.min(0).max(100).optional(),breakdown:breakdown.optional()}),
  rateLimits:z.array(z.object({kind:z.string(),percentUsed:tokens,resetsAt:z.string().datetime().optional()})),
  cost:z.object({usd:number}).optional(),
})

export type ModSessionUsageArgs = z.infer<typeof usageArgs>
export type ModSessionUsage = z.infer<typeof usage>
export type ModUsageReader = (args: ModSessionUsageArgs, signal?: AbortSignal) => Promise<ModSessionUsage>

export function validateModSessionUsageArgs(value: unknown): asserts value is ModSessionUsageArgs {
  const result = usageArgs.safeParse(value)
  if (!result.success) throw new TypeError(`session.usage arguments: ${result.error.message}`)
}

export function validateModSessionUsage(value: unknown): asserts value is ModSessionUsage {
  const result = usage.safeParse(value)
  if (!result.success) throw new TypeError(`session.usage result: ${result.error.message}`)
}

export function captureModSessionUsage(context: Parameters<typeof collectContextData>[0]): ModUsageReader {
  const messages = structuredClone(context.messages)
  const state = context.getAppState()
  const permission = structuredClone(state.toolPermissionContext)
  const model = getRuntimeMainLoopModel({
    permissionMode:permission.mode,
    mainLoopModel:context.options.mainLoopModel,
    exceeds200kTokens:doesMostRecentAssistantMessageExceed200k(messages),
  })
  const captured = {
    messages,
    getAppState: () => ({...state,toolPermissionContext:permission}),
    options:{...context.options,mainLoopModel:model,tools:[...context.options.tools],agentDefinitions:{
      ...context.options.agentDefinitions,
      activeAgents:[...context.options.agentDefinitions.activeAgents],
      allAgents:[...context.options.agentDefinitions.allAgents],
    }},
  }
  const window = getContextWindowForModel(model)
  const current = getCurrentUsage(getMessagesAfterCompactBoundary(messages))
  const value: ModSessionUsage = {
    context:{window,...(current ? {
      tokens:current.input_tokens + current.cache_creation_input_tokens + current.cache_read_input_tokens,
      percent:calculateContextPercentages(current,window).used!,
    } : {})},
    rateLimits:Object.entries(getRawUtilization()).flatMap(([kind,reading]) =>
      Number.isFinite(reading.utilization) && Number.isFinite(reading.resets_at)
        ? [{kind,percentUsed:Math.round(reading.utilization*1000)/10,resetsAt:new Date(reading.resets_at*1000).toISOString()}]
        : []),
    cost:{usd:getTotalCost()},
  }
  return async (args, signal) => {
    validateModSessionUsageArgs(args)
    signal?.throwIfAborted()
    const result = structuredClone(value)
    if (args.breakdown) {
      const data = await collectContextData(captured,{detail:args.breakdown,columns:args.columns},signal)
      // Project through the public schema; internal /context sections stay on the host.
      result.context.breakdown = breakdown.parse(data)
    }
    return result
  }
}
