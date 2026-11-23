import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import {
  executePostModelSwitchHooks,
  executePreModelSwitchHooks,
  type ModelSwitchHookInfo,
} from '../hooks.js'
import { escapeSystemReminderTags, wrapInSystemReminder } from '../messages.js'
import { getModelSwitchCacheFacts } from '../promptCacheFacts.js'
import { tokenCountFromLastAPIResponse } from '../tokens.js'
import {
  getDefaultMainLoopModel,
  getDefaultMainLoopModelSetting,
  getMainLoopModel,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
} from './model.js'

/**
 * Describe a requested switch to `requestedModel` (null = default) for the
 * PreModelSwitch/PostModelSwitch hooks. Call before the switch is applied.
 */
export function getModelSwitchHookInfo(
  requestedModel: string | null,
  messages: Message[],
): ModelSwitchHookInfo {
  const toModel =
    requestedModel === null
      ? getDefaultMainLoopModel()
      : parseUserSpecifiedModel(requestedModel)
  const contextTokens = tokenCountFromLastAPIResponse(messages)
  return {
    fromModel: getMainLoopModel(),
    toModel,
    requestedModel,
    contextTokens,
    cache: getModelSwitchCacheFacts(messages, toModel, contextTokens),
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
 * What /model shows when a PreModelSwitch hook refused the switch to
 * `requestedModel` (null = default), worded like official 2.1.329.
 */
export function describeBlockedModelSwitch(
  requestedModel: string | null,
  reason: string | undefined,
): string {
  const label = renderDefaultModelSetting(
    requestedModel ?? getDefaultMainLoopModelSetting(),
  )
  return `Model switch to ${requestedModel === null ? `${label} (default)` : label} was blocked by a PreModelSwitch hook${reason ? `: ${reason}` : ''}`
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
