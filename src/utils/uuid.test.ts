import { expect, test } from 'bun:test'
import { createAgentId } from './uuid.js'
import { toAgentId } from '../types/ids.js'

test('official logical Agent IDs sanitize only invalid labels and keep the native 63 character limit', () => {
  for (const [input,label] of [[undefined,''],['reviewer','reviewer'],['汉字 A/@!','A'],['x'.repeat(70),'x'.repeat(63)],['漢字',''],['a_b-c','a_b-c']] as const) {
    const id = createAgentId(input)
    expect(id).toMatch(new RegExp('^a'+(label?label+'-':'')+'[0-9a-f]{16}$'))
    expect(toAgentId(id)).toBe(id)
  }
  expect(createAgentId('reviewer')).not.toBe(createAgentId('reviewer'))
  for (const id of ['afoo bar-0123456789abcdef','a漢字-0123456789abcdef','a'+'x'.repeat(64)+'-0123456789abcdef','a0123456789abcde','a0123456789abcdeg','reviewer@team']) expect(toAgentId(id)).toBeNull()
})
