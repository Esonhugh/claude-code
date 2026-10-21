import { isEnvTruthy } from '../../utils/envUtils.js'

/**
 * Auto mode: when the conversation is too long for the classifier, official
 * 2.1.288+ denies the checked tool call and compacts before the next request
 * instead of prompting. The permission check records the request here; the
 * query loop's autocompact step takes it. Kept apart from autoCompact.ts so
 * permissions.ts does not import the compaction stack.
 *
 * A request is keyed by agent and by the transcript head ("epoch", the first
 * message uuid). Once a compaction was attempted for an epoch, an overflow on
 * the same head means compaction did not help, so the caller falls back to
 * its usual permission handling.
 */
type ClassifierOverflowRequest = {
  epoch: string
  deniedToolNames: string[]
}

const states = new Map<
  string,
  { pending?: ClassifierOverflowRequest; spentEpoch?: string }
>()

function stateKey(agentId: string | undefined): string {
  return agentId ?? 'main'
}

export function requestClassifierOverflowCompaction(
  agentId: string | undefined,
  messages: readonly { uuid?: string }[],
  toolName: string,
): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) return false
  const epoch = messages[0]?.uuid
  if (!epoch) return false
  const key = stateKey(agentId)
  const state = states.get(key) ?? {}
  if (state.spentEpoch === epoch) return false
  const deniedToolNames =
    state.pending?.epoch === epoch ? state.pending.deniedToolNames : []
  states.set(key, {
    ...state,
    pending: { epoch, deniedToolNames: [...deniedToolNames, toolName] },
  })
  return true
}

/** Take the pending request for this agent; its epoch counts as attempted. */
export function takeClassifierOverflowCompaction(
  agentId: string | undefined,
): ClassifierOverflowRequest | undefined {
  const key = stateKey(agentId)
  const pending = states.get(key)?.pending
  if (!pending) return undefined
  states.set(key, { spentEpoch: pending.epoch })
  return pending
}

/** Reminder added after the compaction so the model reissues denied calls. */
export function classifierOverflowReminder(deniedToolNames: string[]): string {
  const count = deniedToolNames.length
  if (count === 0) {
    return "The conversation was compacted because it had become too long for auto mode's classifier."
  }
  const one = count === 1
  const names = deniedToolNames.join(', ')
  const calls = one
    ? `an earlier tool call (${names})`
    : `${count} earlier tool calls (${names})`
  return `Auto mode could not review ${calls} because the conversation was too long for its classifier, so ${one ? 'that call' : 'those calls'} did not run. The conversation has now been compacted. If still needed, issue ${one ? 'it' : 'them'} again and ${one ? 'it' : 'they'} will be reviewed normally.`
}
