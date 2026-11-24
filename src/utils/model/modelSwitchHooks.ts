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

const HIDDEN = /\p{Default_Ignorable_Code_Point}|\p{Cf}/u

// A hook's own words as official 2.1.329 shows them: one line of at most 2000
// characters, with nothing a terminal would act on or hide. Official also
// repairs graphemes whose width a terminal would misjudge; that is not here.
function showHookText(text: string): string {
  const whole = text.trimEnd()
  let kept = whole.slice(0, 2000)
  const cut = kept.length < whole.length
  if (cut && /[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1)
  let shown = ''
  for (const char of kept) {
    const code = char.codePointAt(0)!
    if (code === 0xfe0e || code === 0xfe0f) continue
    // Joiners, direction marks and variation selectors are part of real text.
    const partOfText =
      (code >= 0x200c && code <= 0x200f) ||
      (code >= 0xfe00 && code <= 0xfe0d) ||
      (code >= 0x180b && code <= 0x180f)
    const unsafe =
      code < 32 ||
      (code >= 127 && code <= 159) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x10eeee ||
      (HIDDEN.test(char) && !partOfText)
    shown += char === '\t' ? ' ' : unsafe ? '\uFFFD' : char
  }
  return cut ? `${shown}…` : shown
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
  return `Model switch to ${requestedModel === null ? `${label} (default)` : label} was blocked by a PreModelSwitch hook${reason ? `: ${showHookText(reason)}` : ''}`
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
