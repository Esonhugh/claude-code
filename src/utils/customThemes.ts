import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { createSignal } from './signal.js'
import {
  type CustomThemeSetting,
  getBuiltinTheme,
  isThemeColorValue,
  THEME_NAMES,
  type Theme,
  type ThemeName,
} from './theme.js'

export type ThemeOverrides = Partial<Record<keyof Theme, string>>

/** A theme saved as `<config>/themes/<slug>.json`: a built-in base plus color overrides. */
export type CustomTheme = {
  slug: string
  name: string
  base: ThemeName
  overrides: ThemeOverrides
}

const CUSTOM_PREFIX = 'custom:'
const MAX_THEME_FILE_BYTES = 256 * 1024

let loaded: CustomTheme[] | undefined
let previewOverrides: { slug: string; overrides: ThemeOverrides } | null =
  null
const palettes = new Map<string, Theme>()
const changed = createSignal()

/** Fires when the saved themes or the live editor preview change. */
export const subscribeCustomThemes = changed.subscribe

export function getCustomThemesDir(): string {
  return join(getClaudeConfigHomeDir(), 'themes')
}

export function customThemeSetting(slug: string): CustomThemeSetting {
  return `${CUSTOM_PREFIX}${slug}`
}

export function parseCustomThemeSetting(setting: string): string | null {
  return setting.startsWith(CUSTOM_PREFIX)
    ? setting.slice(CUSTOM_PREFIX.length)
    : null
}

export function getCustomThemes(): CustomTheme[] {
  loaded ??= readCustomThemes()
  return loaded
}

export function findCustomTheme(slug: string): CustomTheme | undefined {
  return getCustomThemes().find(theme => theme.slug === slug)
}

export function reloadCustomThemes(): CustomTheme[] {
  loaded = readCustomThemes()
  palettes.clear()
  changed.emit()
  return loaded
}

export function saveCustomTheme(theme: CustomTheme): void {
  const dir = getCustomThemesDir()
  mkdirSync(dir, { recursive: true })
  const { name, base, overrides } = theme
  writeFileSync(
    join(dir, `${theme.slug}.json`),
    JSON.stringify({ name, base, overrides }, null, 2) + '\n',
  )
  reloadCustomThemes()
}

/** Live overrides shown while a custom theme is being edited; null clears them. */
export function setCustomThemePreview(
  slug: string,
  overrides: ThemeOverrides | null,
): void {
  previewOverrides = overrides ? { slug, overrides } : null
  palettes.delete(slug)
  changed.emit()
}

/** The palette for a custom theme; a missing theme falls back to dark. */
export function getCustomThemePalette(slug: string): Theme {
  const cached = palettes.get(slug)
  if (cached) return cached
  const theme = findCustomTheme(slug)
  const overrides =
    previewOverrides?.slug === slug
      ? previewOverrides.overrides
      : (theme?.overrides ?? {})
  const palette = applyThemeOverrides(
    getBuiltinTheme(theme?.base ?? 'dark'),
    overrides,
  )
  palettes.set(slug, palette)
  return palette
}

export function getCustomThemeBase(slug: string): ThemeName {
  return findCustomTheme(slug)?.base ?? 'dark'
}

export function applyThemeOverrides(
  base: Theme,
  overrides: ThemeOverrides,
): Theme {
  const palette = { ...base }
  for (const [token, value] of Object.entries(overrides)) {
    if (Object.hasOwn(base, token) && isThemeColorValue(value)) {
      palette[token as keyof Theme] = value
    }
  }
  return palette
}

/** A file-name-safe slug for `name` that no existing theme uses. */
export function uniqueCustomThemeSlug(
  name: string,
  themes: CustomTheme[],
): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'theme'
  if (!themes.some(theme => theme.slug === slug)) return slug
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`
    if (!themes.some(theme => theme.slug === candidate)) return candidate
  }
}

function readCustomThemes(): CustomTheme[] {
  const dir = getCustomThemesDir()
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  const themes: CustomTheme[] = []
  for (const file of files) {
    if (extname(file) !== '.json') continue
    const theme = readCustomTheme(join(dir, file), basename(file, '.json'))
    if (theme) themes.push(theme)
  }
  return themes.sort((a, b) => a.name.localeCompare(b.name))
}

function readCustomTheme(path: string, slug: string): CustomTheme | undefined {
  let parsed: unknown
  try {
    if (statSync(path).size > MAX_THEME_FILE_BYTES) {
      logForDebugging(`[theme] ${path} exceeds 256KB; skipping`)
      return undefined
    }
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    logForDebugging(`[theme] ${slug}.json: could not read or parse`)
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const raw = parsed as Record<string, unknown>
  const base = (THEME_NAMES as readonly string[]).includes(String(raw.base))
    ? (raw.base as ThemeName)
    : 'dark'
  const basePalette = getBuiltinTheme(base)
  const overrides: ThemeOverrides = {}
  if (typeof raw.overrides === 'object' && raw.overrides !== null) {
    for (const [token, value] of Object.entries(raw.overrides)) {
      if (Object.hasOwn(basePalette, token) && isThemeColorValue(value)) {
        overrides[token as keyof Theme] = value
      }
    }
  }
  return {
    slug,
    name: typeof raw.name === 'string' ? raw.name : slug,
    base,
    overrides,
  }
}
