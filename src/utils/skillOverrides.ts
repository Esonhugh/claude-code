import type { Command } from '../types/command.js'
import { getInitialSettings } from './settings/settings.js'

export const SKILL_OVERRIDE_STATES = [
  'on',
  'name-only',
  'user-invocable-only',
  'off',
] as const
export type SkillOverride = (typeof SKILL_OVERRIDE_STATES)[number]

// Plugin skills are turned off with their plugin, not one by one.
export function isSkillOverridable(cmd: Command): boolean {
  return (
    cmd.type === 'prompt' &&
    (cmd.loadedFrom === 'skills' ||
      cmd.loadedFrom === 'commands_DEPRECATED' ||
      cmd.loadedFrom === 'mcp' ||
      cmd.loadedFrom === 'codex_app')
  )
}

export function getSkillOverride(
  cmd: Command,
  overrides = getInitialSettings().skillOverrides,
): SkillOverride {
  if (!isSkillOverridable(cmd)) return 'on'
  const value = overrides?.[cmd.name]
  return value && SKILL_OVERRIDE_STATES.includes(value) ? value : 'on'
}

/** off and user-invocable-only skills are hidden from the model. */
export function isSkillHiddenFromModel(
  cmd: Command,
  overrides = getInitialSettings().skillOverrides,
): boolean {
  const override = getSkillOverride(cmd, overrides)
  return override === 'off' || override === 'user-invocable-only'
}

export function nextSkillOverride(current: SkillOverride): SkillOverride {
  const index = SKILL_OVERRIDE_STATES.indexOf(current)
  return SKILL_OVERRIDE_STATES[(index + 1) % SKILL_OVERRIDE_STATES.length]!
}
