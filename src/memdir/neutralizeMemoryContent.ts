import {
  CHANNEL_MESSAGE_TAG,
  CHANNEL_TAG,
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  CROSS_SESSION_MESSAGE_TAG,
  FORK_BOILERPLATE_TAG,
  REMOTE_REVIEW_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TERMINAL_OUTPUT_TAGS,
  TICK_TAG,
} from '../constants/xml.js'
import { escapeTagOpeners } from '../utils/xml.js'

// Markup the harness itself emits; a memory file must not be able to forge it.
const HARNESS_TAGS = [
  ...TERMINAL_OUTPUT_TAGS,
  'bash-exit-code',
  COMMAND_NAME_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_ARGS_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  CROSS_SESSION_MESSAGE_TAG,
  CHANNEL_MESSAGE_TAG,
  CHANNEL_TAG,
  'agent-message',
  REMOTE_REVIEW_TAG,
  TICK_TAG,
  FORK_BOILERPLATE_TAG,
  'fetched-web-content',
  'coordinator-relay',
  'system-reminder',
  'system_reminder',
  'function_results',
  'function_calls',
  'tool_use_error',
  'sandbox_violations',
  'persisted-output',
  'total_tokens',
  'user-prompt-submit-hook',
  'antml',
  'cc-memory',
  'cc_memory',
  'ccmemory',
]

// Format/private-use/unassigned/surrogate/default-ignorable code points and
// C0/C1 controls, keeping tab, newline, ZWNJ, ZWJ and emoji variation selectors.
// eslint-disable-next-line no-control-regex, no-misleading-character-class
const INVISIBLE = /(?![\u200c\u200d\ufe0e\ufe0f])[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu

/**
 * Neutralize memory file text before it is injected into a prompt: drop
 * invisible characters and escape tags that imitate harness markup
 * (`<system-reminder>` becomes `<\system-reminder>`).
 */
export function neutralizeMemoryContent(text: string): string {
  return escapeTagOpeners(
    text.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(INVISIBLE, ''),
    HARNESS_TAGS,
  )
}
