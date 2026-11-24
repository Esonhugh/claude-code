import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isThemeMode, readThemeMode, windowBackground, writeThemeMode } from './theme.js'

let dir
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})
const file = () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-desktop-theme-'))
  return join(dir, 'appearance.json')
}

describe('theme', () => {
  it('accepts only the page modes', () => {
    for (const mode of ['system', 'light', 'dark']) expect(isThemeMode(mode)).toBe(true)
    for (const mode of ['auto', 'Dark', '', undefined, null, 1, {}]) expect(isThemeMode(mode)).toBe(false)
  })

  it('reads back what was written, without leaving a temporary file', () => {
    const path = file()
    writeThemeMode(path, 'dark')
    expect(readThemeMode(path)).toBe('dark')
    writeThemeMode(path, 'light')
    expect(readThemeMode(path)).toBe('light')
    expect(readdirSync(dir)).toEqual(['appearance.json'])
  })

  it('falls back to system for a missing, corrupt or unknown file', () => {
    const path = file()
    expect(readThemeMode(path)).toBe('system')
    writeFileSync(path, '{not json')
    expect(readThemeMode(path)).toBe('system')
    writeFileSync(path, '{"theme":"auto"}')
    expect(readThemeMode(path)).toBe('system')
    writeFileSync(path, 'null')
    expect(readThemeMode(path)).toBe('system')
  })

  it('matches the page background', () => {
    expect(windowBackground(false)).toBe('#faf9f5')
    expect(windowBackground(true)).toBe('#1f1d1a')
  })
})
