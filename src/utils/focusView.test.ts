import { expect, test } from 'bun:test'
import type { RenderableMessage } from '../types/message.js'
import { applyFocusView, focusHiddenSuffix } from './focusView.js'

let n = 0
const base = () => ({ uuid: `u${++n}`, timestamp: '2026-10-24T00:00:00.000Z' })

const prompt = (text: string) =>
  ({ ...base(), type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) as unknown as RenderableMessage
const toolUse = (name: string) =>
  ({ ...base(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name, input: {} }] } }) as unknown as RenderableMessage
const toolResult = () =>
  ({ ...base(), type: 'user', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }) as unknown as RenderableMessage
const text = (t: string) =>
  ({ ...base(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } }) as unknown as RenderableMessage
const readGroup = (readCount: number, bashCount: number) =>
  ({ ...base(), type: 'collapsed_read_search', count: readCount + bashCount, isCollapsed: true, messages: [], readCount, bashCount, searchCount: 0, listCount: 0 }) as unknown as RenderableMessage
const duration = () =>
  ({ ...base(), type: 'system', subtype: 'turn_duration', durationMs: 6000 }) as unknown as RenderableMessage

const shape = (rows: RenderableMessage[]) =>
  rows.map(r => {
    if (r.type === 'system') return `${r.subtype}:${r.content ?? ''}:${(r as { focusHiddenCount?: number }).focusHiddenCount ?? ''}`
    if (r.type === 'user') return 'user'
    if (r.type === 'assistant') {
      const b = r.message.content[0]!
      return b.type === 'text' ? `text:${b.text}` : `tool:${b.type}`
    }
    return r.type
  })

test('completed turn keeps prompt, one summary line and the final response', () => {
  const rows = [
    prompt('do it'),
    text('Let me look first'),
    readGroup(1, 1),
    toolUse('Write'),
    toolResult(),
    text('Done'),
    duration(),
  ]
  expect(shape(applyFocusView(rows, false))).toEqual([
    'user',
    'focus_summary:Edited 1 file, read 1 file, ran 1 shell command:',
    'text:Done',
    'turn_duration::3',
  ])
})

test('active turn shows present-tense summary and hides working notes', () => {
  const rows = [prompt('go'), text('thinking aloud'), toolUse('Bash'), toolResult()]
  expect(shape(applyFocusView(rows, true))).toEqual([
    'user',
    'focus_summary:Running 1 shell command…:',
  ])
})

test('a lone read/search group stays as-is and hides nothing', () => {
  const rows = [prompt('look'), readGroup(1, 1), toolResult(), text('ok'), duration()]
  expect(shape(applyFocusView(rows, false))).toEqual([
    'user',
    'collapsed_read_search',
    'text:ok',
    'turn_duration::',
  ])
})

test('turn without tool work is unchanged', () => {
  const rows = [prompt('hi'), text('hello'), duration()]
  expect(shape(applyFocusView(rows, false))).toEqual([
    'user',
    'text:hello',
    'turn_duration::',
  ])
})

test('hidden suffix wording', () => {
  expect(focusHiddenSuffix(undefined)).toBe('')
  expect(focusHiddenSuffix(1)).toBe(' · 1 message hidden (/focus to show)')
  expect(focusHiddenSuffix(2)).toBe(' · 2 messages hidden (/focus to show)')
})
