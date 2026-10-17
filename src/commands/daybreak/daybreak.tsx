import * as React from 'react'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'

const USAGE = 'Usage: /daybreak [blue|red|off]'
type Daybreak = NonNullable<SettingsJson['daybreak']>

export function showCurrentDaybreak(): string {
  const daybreak = getInitialSettings().daybreak ?? 'off'
  if (daybreak === 'off') {
    return `Daybreak is off; standard access program selected. ${USAGE}`
  }
  return `Current Daybreak program: ${daybreak}. ${USAGE}`
}

export function executeDaybreak(args: string): string {
  const daybreak = args.trim().toLowerCase()
  if (daybreak !== 'blue' && daybreak !== 'red' && daybreak !== 'off') {
    return `Invalid argument: ${args}. ${USAGE}`
  }

  const result = updateSettingsForSource('userSettings', {
    daybreak: daybreak as Daybreak,
  })
  if (result.error) return `Failed to set Daybreak: ${result.error.message}`
  return daybreak === 'off'
    ? 'Daybreak disabled; standard access program selected'
    : `Daybreak set to ${daybreak}`
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  const normalized = args?.trim() ?? ''
  onDone(normalized ? executeDaybreak(normalized) : showCurrentDaybreak())
  return null
}
