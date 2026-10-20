import { feature } from 'bun:bundle'
import z from 'zod/v4'
import { PAUSE_ICON } from '../../constants/figures.js'
// Types extracted to src/types/permissions.ts to break import cycles
import {
  EXTERNAL_PERMISSION_MODES,
  type ExternalPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from '../../types/permissions.js'
import { lazySchema } from '../lazySchema.js'


// Re-export for backwards compatibility
export {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type ExternalPermissionMode,
  type PermissionMode,
}

// Official 2.1.200 shows the `default` mode as "Manual" and accepts `manual`
// wherever a mode is configured; internally it stays `default`.
export const MANUAL_PERMISSION_MODE_ALIAS = 'manual'

/** --permission-mode choices as --help lists them (`manual` for `default`). */
export const PERMISSION_MODE_CHOICES = PERMISSION_MODES.map(mode =>
  mode === 'default' ? MANUAL_PERMISSION_MODE_ALIAS : mode,
)

export function normalizePermissionModeAlias(mode: string): string {
  return mode === MANUAL_PERMISSION_MODE_ALIAS ? 'default' : mode
}

export const permissionModeSchema = lazySchema(() => z.enum(PERMISSION_MODES))
export const externalPermissionModeSchema = lazySchema(() =>
  z.enum(EXTERNAL_PERMISSION_MODES),
)

type ModeColorKey =
  | 'text'
  | 'planMode'
  | 'permission'
  | 'autoAccept'
  | 'error'
  | 'warning'

type PermissionModeConfig = {
  title: string
  shortTitle: string
  symbol: string
  color: ModeColorKey
  external: ExternalPermissionMode
}

const PERMISSION_MODE_CONFIG: Partial<
  Record<PermissionMode, PermissionModeConfig>
> = {
  default: {
    title: 'Manual',
    shortTitle: 'Manual',
    symbol: '',
    color: 'text',
    external: 'default',
  },
  plan: {
    title: 'Plan Mode',
    shortTitle: 'Plan',
    symbol: PAUSE_ICON,
    color: 'planMode',
    external: 'plan',
  },
  acceptEdits: {
    title: 'Accept edits',
    shortTitle: 'Accept',
    symbol: '⏵⏵',
    color: 'autoAccept',
    external: 'acceptEdits',
  },
  bypassPermissions: {
    title: 'Bypass Permissions',
    shortTitle: 'Bypass',
    symbol: '⏵⏵',
    color: 'error',
    external: 'bypassPermissions',
  },
  dontAsk: {
    title: "Don't Ask",
    shortTitle: 'DontAsk',
    symbol: '⏵⏵',
    color: 'error',
    external: 'dontAsk',
  },
  ...(feature('TRANSCRIPT_CLASSIFIER')
    ? {
        auto: {
          title: 'Auto mode',
          shortTitle: 'Auto',
          symbol: '⏵⏵',
          color: 'warning' as ModeColorKey,
          external: 'auto' as ExternalPermissionMode,
        },
      }
    : {}),
}

/**
 * Type guard to check if a PermissionMode is an ExternalPermissionMode.
 * Official 2.1.292 reports every mode except bubble, auto included.
 */
export function isExternalPermissionMode(
  mode: PermissionMode,
): mode is ExternalPermissionMode {
  return mode !== 'bubble'
}

function getModeConfig(mode: PermissionMode): PermissionModeConfig {
  return PERMISSION_MODE_CONFIG[mode] ?? PERMISSION_MODE_CONFIG.default!
}

export function toExternalPermissionMode(
  mode: PermissionMode,
): ExternalPermissionMode {
  return getModeConfig(mode).external
}

export function permissionModeFromString(str: string): PermissionMode {
  const mode = normalizePermissionModeAlias(str)
  return (PERMISSION_MODES as readonly string[]).includes(mode)
    ? (mode as PermissionMode)
    : 'default'
}

export function permissionModeTitle(mode: PermissionMode): string {
  return getModeConfig(mode).title
}

export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return mode === 'default' || mode === undefined
}

export function permissionModeShortTitle(mode: PermissionMode): string {
  return getModeConfig(mode).shortTitle
}

export function permissionModeSymbol(mode: PermissionMode): string {
  return getModeConfig(mode).symbol
}

export function getModeColor(mode: PermissionMode): ModeColorKey {
  return getModeConfig(mode).color
}
