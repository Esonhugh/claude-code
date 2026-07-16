import {
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
} from '../constants/figures.js'
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
  return `${effortLevelToSymbol(level)} ${applied ?? level} · /effort`
}

export function effortLevelToSymbol(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return EFFORT_LOW
    case 'medium':
      return EFFORT_MEDIUM
    case 'high':
      return EFFORT_HIGH
    case 'max':
      return EFFORT_MAX
    default:
      // Defensive: level can originate from remote config. If an unknown
      // value slips through, render the high symbol rather than undefined.
      return EFFORT_HIGH
  }
}
