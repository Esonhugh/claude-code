import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import {
  executePostModelSwitchHooks,
  executePreModelSwitchHooks,
  type ModelSwitchHookInfo,
} from '../hooks.js'
import { escapeSystemReminderTags, wrapInSystemReminder } from '../messages.js'
import { tokenCountFromLastAPIResponse } from '../tokens.js'
import {
  getDefaultMainLoopModel,
  getMainLoopModel,
  parseUserSpecifiedModel,
} from './model.js'

/**
 * Describe a requested switch to `requestedModel` (null = default) for the
 * PreModelSwitch/PostModelSwitch hooks. Call before the switch is applied.
 */
export function getModelSwitchHookInfo(
  requestedModel: string | null,
  messages: Message[],
): ModelSwitchHookInfo {
  return {
    fromModel: getMainLoopModel(),
    toModel:
      requestedModel === null
        ? getDefaultMainLoopModel()
        : parseUserSpecifiedModel(requestedModel),
    requestedModel,
    contextTokens: tokenCountFromLastAPIResponse(messages),
  }
}

export async function checkModelSwitch(
  info: ModelSwitchHookInfo,
  source: 'command' | 'picker' | 'sdk',
  toolUseContext?: ToolUseContext,
): Promise<{ decision: 'proceed' | 'ask' | 'block'; reason?: string }> {
  return executePreModelSwitchHooks(
    { ...info, source },
    toolUseContext,
    toolUseContext?.abortController.signal,
  )
}

/**
 * Run PostModelSwitch hooks and return their additionalContext as
 * model-visible meta messages for the next request.
 */
export async function getPostModelSwitchContext(
  info: ModelSwitchHookInfo,
  source: 'command' | 'picker' | 'sdk',
  toolUseContext?: ToolUseContext,
): Promise<string[] | undefined> {
  const contexts = await executePostModelSwitchHooks(
    { ...info, source },
    toolUseContext,
  )
  return contexts.length > 0
    ? contexts.map(context =>
        wrapInSystemReminder(escapeSystemReminderTags(context)),
      )
    : undefined
}
