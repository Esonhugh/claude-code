import { expect, test } from 'bun:test'
import official from '../services/mods/fixtures/promptThemes292.json'
import { getTheme, THEME_NAMES, type Theme } from './theme.js'
import { mergePromptDecorations } from './textHighlighting.js'

// Exact 2.1.292 palette literals and r1 were executed from the binary bytes recorded in the fixture.
// Compare RGB channels/ANSI names; spacing inside rgb(...) does not affect terminal color.
for (const name of THEME_NAMES) {
  test('official 2.1.292 palette: ' + name, () => {
    expect(official.version).toBe('2.1.292')
    const expected = official.themes[name]
    expect(Object.keys(expected)).toHaveLength(72)
    const actual = getTheme(name)
    for (const [key, value] of Object.entries(expected)) {
      expect(Object.hasOwn(actual, key)).toBe(true)
      expect(actual[key as keyof Theme]?.replace(/\s/g, '')).toBe(value.replace(/\s/g, ''))
    }
    const added: Pick<Theme, 'skill' | 'autoAcceptShimmer' | 'effortUltra'> = actual
    expect(added.skill).toBeDefined()
    expect(added.autoAcceptShimmer).toBeDefined()
    expect(added.effortUltra).toBeDefined()
  })
}
test('every pinned palette name remains a usable Mods paint color in all themes', () => {
  expect(Object.keys(official.themes)).toEqual([...THEME_NAMES])
  for (const name of THEME_NAMES) {
    const theme = getTheme(name)
    for (const color of Object.keys(official.themes[name]) as (keyof typeof official.themes.dark)[]) {
      expect(mergePromptDecorations([], [{ start: 0, end: 1, color, backgroundColor: color }], theme)).toEqual([
        { start: 0, end: 1, color, backgroundColor: color, shimmerColor: undefined, priority: 0 },
      ])
    }
  }
})
