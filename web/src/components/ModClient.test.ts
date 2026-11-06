import { describe, expect, it } from 'bun:test'
import { clientTree } from './ModClient'

const limits = { nodes: 20000, depth: 32, chars: 100000 }

describe('Client trees', () => {
  it('keeps known elements and turns held closures into presses of the plugin', () => {
    const text = JSON.stringify({
      type: 'Box',
      props: { flexDirection: 'column' },
      children: ['hi', { type: 'Button', props: { key: 'inc', label: 'Inc' }, held: 4 }],
    })
    expect(clientTree(text, 'demo', limits)).toEqual({
      type: 'Box',
      props: { flexDirection: 'column' },
      children: ['hi', { type: 'Button', props: { key: 'inc', label: 'Inc' }, press: { plugin: 'demo', handle: 4 } }],
    })
  })

  it('drops what a Client may not draw and any press it claims for itself', () => {
    const text = JSON.stringify({
      type: 'Box',
      children: [
        { type: 'Client', props: { key: 'x', module: './a.tsx' }, client: { plugin: 'other' } },
        { type: 'engine', ref: 0 },
        { type: 'Raster', props: {} },
        { type: 'Text', press: { plugin: 'other', handle: 1 }, children: ['ok'] },
      ],
    })
    expect(clientTree(text, 'demo', limits)).toEqual({ type: 'Box', children: [{ type: 'Text', children: ['ok'] }] })
  })

  it('refuses a tree past its bounds', () => {
    const deep = (n: number): unknown => (n ? { type: 'Box', children: [deep(n - 1)] } : 'x')
    expect(() => clientTree(JSON.stringify(deep(40)), 'demo', limits)).toThrow('deeper than 32')
    const wide = { type: 'Box', children: Array.from({ length: 30 }, () => ({ type: 'Text' })) }
    expect(() => clientTree(JSON.stringify(wide), 'demo', { ...limits, nodes: 10 })).toThrow('more than 10 nodes')
    expect(() => clientTree('"' + 'a'.repeat(200) + '"', 'demo', { ...limits, chars: 100 })).toThrow('more than 100 characters')
  })
})
