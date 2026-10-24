import {
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
  EFFORT_XHIGH,
} from '../constants/figures.js'
import type { Notification } from '../context/notifications.js'
import {
  type EffortLevel,
  type EffortValue,
  convertEffortValueToLevel,
  modelSupportsEffort,
  resolveAppliedEffort,
} from '../utils/effort.js'

/**
 * Build the text for the effort-changed notification, e.g. "◐ medium · /effort".
 * Returns undefined if the model doesn't support effort.
 */
export function getEffortNotificationText(
  effortValue: EffortValue | undefined,
  model: string,
): string | undefined {
  if (!modelSupportsEffort(model)) return undefined
  const applied = resolveAppliedEffort(model, effortValue)
  const level = convertEffortValueToLevel(applied ?? 'high')
  return `${effortLevelToSymbol(applied === 'xhigh' ? 'xhigh' : level)} ${applied ?? level} · /effort`
}

/** The effort notice; a newer one replaces the one still on screen instead of being dropped as a duplicate. */
export function effortNotification(text: string): Notification {
  return { key: 'effort-level', text, priority: 'high', timeoutMs: 12_000, fold: (_shown, incoming) => incoming }
}

export function effortLevelToSymbol(level: EffortLevel): string {
  switch (level) {
    case 'minimal':
    case 'low':
      return EFFORT_LOW
    case 'medium':
      return EFFORT_MEDIUM
    case 'high':
      return EFFORT_HIGH
    case 'xhigh':
      return EFFORT_XHIGH
    case 'max':
      return EFFORT_MAX
    default:
      // Defensive: level can originate from remote config. If an unknown
      // value slips through, render the high symbol rather than undefined.
      return EFFORT_HIGH
  }
}
