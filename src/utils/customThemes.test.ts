import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getCustomThemesDir,
  reloadCustomThemes,
  saveCustomTheme,
  setCustomThemePreview,
  uniqueCustomThemeSlug,
} from './customThemes.js'
import { resolveThemeSetting } from './systemTheme.js'
import { getBuiltinTheme, getTheme, isThemeColorValue } from './theme.js'

const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'custom-themes-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
  reloadCustomThemes()
})

test('theme color values accept the official formats only', () => {
  for (const ok of ['rgb(1,2,3)', 'rgb(1, 2, 3)', '#a1b2c3', '#abc', 'ansi256(42)', 'ansi:redBright']) {
    expect(isThemeColorValue(ok)).toBe(true)
  }
  for (const bad of ['red', 'rgb(1,2)', '#abcd', 'ansi:purple', 'ansi256(x)', 42]) {
    expect(isThemeColorValue(bad)).toBe(false)
  }
})

test('a saved custom theme renders as its base plus valid overrides', () => {
  saveCustomTheme({
    slug: 'ocean',
    name: 'Ocean',
    base: 'light',
    overrides: { claude: '#123456' },
  })
  expect(JSON.parse(readFileSync(join(getCustomThemesDir(), 'ocean.json'), 'utf8'))).toEqual({
    name: 'Ocean',
    base: 'light',
    overrides: { claude: '#123456' },
  })

  const palette = getTheme('custom:ocean')
  expect(palette.claude).toBe('#123456')
  expect(palette.text).toBe(getBuiltinTheme('light').text)
  expect(resolveThemeSetting('custom:ocean')).toBe('light')
})

test('theme files drop unknown tokens, bad colors and bad bases', () => {
  mkdirSync(getCustomThemesDir(), { recursive: true })
  writeFileSync(
    join(getCustomThemesDir(), 'messy.json'),
    JSON.stringify({ name: 'Messy', base: 'neon', overrides: { claude: 'blue', nope: '#fff', error: 'ansi:red' } }),
  )
  writeFileSync(join(getCustomThemesDir(), 'broken.json'), '{')
  const themes = reloadCustomThemes()
  expect(themes.map(theme => theme.slug)).toEqual(['messy', 'ocean'])
  expect(themes[0]).toEqual({ slug: 'messy', name: 'Messy', base: 'dark', overrides: { error: 'ansi:red' } })
})

test('a missing custom theme falls back to dark', () => {
  expect(getTheme('custom:gone')).toEqual(getBuiltinTheme('dark'))
  expect(resolveThemeSetting('custom:gone')).toBe('dark')
})

test('editor previews apply until cleared', () => {
  setCustomThemePreview('ocean', { claude: 'ansi:green' })
  expect(getTheme('custom:ocean').claude).toBe('ansi:green')
  setCustomThemePreview('ocean', null)
  expect(getTheme('custom:ocean').claude).toBe('#123456')
})

test('slugs are file-name safe and unique', () => {
  const themes = reloadCustomThemes()
  expect(uniqueCustomThemeSlug('My Theme!', themes)).toBe('my-theme')
  expect(uniqueCustomThemeSlug('Ocean', themes)).toBe('ocean-2')
  expect(uniqueCustomThemeSlug('***', themes)).toBe('theme')
})
