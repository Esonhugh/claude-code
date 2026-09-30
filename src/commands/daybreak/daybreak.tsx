import * as React from 'react'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'

const USAGE = 'Usage: /daybreak [blue|red]'
type Daybreak = NonNullable<SettingsJson['daybreak']>

export function showCurrentDaybreak(): string {
  const daybreak = getInitialSettings().daybreak
  return daybreak
    ? `Current Daybreak program: ${daybreak}. ${USAGE}`
    : `Daybreak is not configured. ${USAGE}`
}

export function executeDaybreak(args: string): string {
  const daybreak = args.trim().toLowerCase()
  if (daybreak !== 'blue' && daybreak !== 'red') {
    return `Invalid argument: ${args}. ${USAGE}`
  }

  const result = updateSettingsForSource('userSettings', {
    daybreak: daybreak as Daybreak,
  })
  return result.error
    ? `Failed to set Daybreak: ${result.error.message}`
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
