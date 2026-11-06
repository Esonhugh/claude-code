import { describe, expect, it } from 'bun:test'
import { modColor, modStyle, safeModLink } from './Mods'

describe('Mods drawing', () => {
  it('takes terminal colour names, hex and rgb, and drops anything else', () => {
    expect(modColor('cyan')).toBe('var(--mod-cyan, #1b7c83)')
    expect(modColor('redBright')).toBe('var(--mod-red, #d1242f)')
    expect(modColor('#ff0')).toBe('#ff0')
    expect(modColor('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)')
    expect(modColor('red; background: url(x)')).toBeUndefined()
    expect(modColor('url(https://e.x/a.png)')).toBeUndefined()
    expect(modColor(3)).toBeUndefined()
  })
  it('lays a Box out in cells and a Text with its marks', () => {
    expect(modStyle('Box', { flexDirection: 'column', gap: 1, paddingX: 2, width: '50%', borderStyle: 'round' })).toMatchObject({
      display: 'flex',
      flexDirection: 'column',
      rowGap: '1.45em',
      paddingLeft: '2ch',
      paddingRight: '2ch',
      width: '50%',
      borderRadius: 8,
    })
    expect(modStyle('Box', { flexDirection: 'sideways', width: 'calc(1px)' })).toMatchObject({ flexDirection: 'row', width: undefined })
    expect(modStyle('Text', { bold: true, dimColor: true, color: 'green', strikethrough: true })).toEqual({
      color: 'var(--mod-green, #1a7f37)',
      fontWeight: 600,
      textDecoration: 'line-through',
      opacity: 0.6,
    })
  })
  it('opens only web and mail links', () => {
    expect(safeModLink('https://example.com')).toBe(true)
    expect(safeModLink('mailto:a@b.c')).toBe(true)
    expect(safeModLink('javascript:alert(1)')).toBe(false)
    expect(safeModLink('/relative')).toBe(false)
  })
})
