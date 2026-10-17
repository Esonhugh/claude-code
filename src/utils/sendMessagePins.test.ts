import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { AppState } from '../state/AppStateStore.js'
import { asAgentId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import {
  bindSubagentRecipient, normalizeRecipientName, parseRecipientRef,
  resolveSubagentRecipient, restoreSendMessagePins, retainLiveAgentNames, subagentRef,
} from './sendMessagePins.js'

const A = 'a0123456789abcdef', B = 'afedcba9876543210'
const pin = { id: A, name: 'pin-target', ref: subagentRef(A) }
const state = (names: [string, string][] = [['pin-target', A]]) => ({
  tasks: {}, sendMessagePins: {}, agentNameRegistry: new Map(names.map(([name, id]) => [name, asAgentId(id)])),
}) as AppState
const use = (name = 'SendMessage', id = 'call-1') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, id }] } }) as Message
const receipt = (metadata: unknown, id = 'call-1', error = false, wire?: string) => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: wire ?? '' }] }, toolUseResult: metadata }) as Message

for (const [input, output] of [
  ['  ＰＩＮ\u200b Target  ', 'pin-target'],
  ['A\u0000B\ud800C', 'abc'],
  ['A\t\nB', 'a-b'],
  ['Straße', 'straße'],
  ['İ', 'i\u0307'],
]) test(`recipient normalization: ${JSON.stringify(input)}`, () => expect(normalizeRecipientName(input!)).toBe(output!))

test('local names, normalized names, raw IDs and prefixes resolve to their canonical target', () => {
  const s = state()
  for (const input of ['pin-target', ' ＰＩＮ-TARGET\u200b ', 'pin']) expect(resolveSubagentRecipient(s, input)).toMatchObject({ kind: 'one', recipient: pin })
  expect(resolveSubagentRecipient(s, A)).toMatchObject({ kind: 'one', recipient: { ...pin, name: A } })
  expect(resolveSubagentRecipient(s, 'pi')).toBeNull()
})

test('full spelling wins and distinct prefix names are ambiguous', () => {
  const s = state([['Pin Target', A], ['pin-target', B], ['pine', B]])
  expect(resolveSubagentRecipient(s, 'pin-target')).toMatchObject({ kind: 'one', recipient: { id: B } })
  expect(resolveSubagentRecipient(s, ' ＰＩＮ TARGET ')).toMatchObject({ kind: 'one', recipient: { id: A } })
  expect(resolveSubagentRecipient(s, 'pin')).toMatchObject({ kind: 'ambiguous' })
})

test('only the displayed exact reference confirms a local recipient', () => {
  const s = state()
  expect(parseRecipientRef(`pin-target [${pin.ref}]`)).toEqual({ name: 'pin-target', ref: pin.ref })
  expect(resolveSubagentRecipient(s, `PIN-TARGET [${pin.ref}]`)).toMatchObject({ kind: 'one', recipient: pin })
  for (const ref of [pin.ref.toUpperCase(), pin.ref + '0', '000000', 'abcde']) expect(resolveSubagentRecipient(s, `pin-target [${ref}]`)).toBeNull()
})

test('same identity preserves the original receipt object and name', () => {
  const s = state(); s.sendMessagePins = { 'pin-target': pin }
  const result = bindSubagentRecipient('PIN-TARGET', { ...pin, name: 'PIN-TARGET' }, s, () => { throw new Error('same identity must not update') })
  expect(result).toEqual({ kind: 'proceed', pin }); if (result.kind === 'proceed') expect(result.pin).toBe(pin)
})

test('name reuse refuses the send; a ref permits rebinding before execution', () => {
  let s = state(); s.sendMessagePins = { 'pin-target': pin }
  const next = { id: B, name: pin.name, ref: subagentRef(B) }
  const write = (update: (previous: AppState) => AppState) => { s = update(s) }
  for (const to of ['pin-target', 'pin']) expect(bindSubagentRecipient(to, next, s, write)).toMatchObject({ kind: 'rebound' })
  expect(s.sendMessagePins['pin-target']).toEqual(pin)
  expect(bindSubagentRecipient(`pin-target [${next.ref}]`, next, s, write)).toEqual({ kind: 'proceed', pin: next })
  expect(s.sendMessagePins['pin-target']).toEqual(next)
})

test('different literal spelling is an intentional upstream exception without repinning', () => {
  const s = state(); s.sendMessagePins = { 'pin-target': pin }
  expect(bindSubagentRecipient('PIN-TARGET', { id: B, name: 'PIN-TARGET', ref: subagentRef(B) }, s, () => { throw new Error('literal exception must not update') })).toEqual({ kind: 'proceed' })
})

test('prototype properties are not mistaken for conversation pins', () => {
  let s = state(); s.sendMessagePins = Object.create({ constructor: pin })
  const target = { id: B, name: 'constructor', ref: subagentRef(B) }
  expect(bindSubagentRecipient('constructor', target, s, update => { s = update(s) })).toEqual({ kind: 'proceed', pin: target })
  expect(Object.hasOwn(s.sendMessagePins, 'constructor')).toBe(true)
})

for (const [label, history, expected] of [
  ['matched success', [use(), receipt({ success: true, pin })], { 'pin-target': pin }],
  ['false success', [use(), receipt({ success: false, pin })], {}],
  ['wrong tool', [use('Read'), receipt({ success: true, pin })], {}],
  ['unmatched use', [use(), receipt({ success: true, pin }, 'other')], {}],
  ['error result', [use(), receipt({ success: true, pin }, 'call-1', true)], {}],
  ['invalid ID', [use(), receipt({ success: true, pin: { ...pin, id: 'worker' } })], {}],
  ['invalid ref', [use(), receipt({ success: true, pin: { ...pin, ref: 'xyzxyz' } })], {}],
  ['empty name', [use(), receipt({ success: true, pin: { ...pin, name: '' } })], {}],
  ['long name', [use(), receipt({ success: true, pin: { ...pin, name: 'a'.repeat(201) } })], {}],
  ['wire JSON is not metadata', [use(), receipt(undefined, 'call-1', false, JSON.stringify({ success: true, pin }))], {}],
  ['result preceding use', [receipt({ success: true, pin }), use()], {}],
] as const) test(`pin restoration accepts only valid metadata: ${label}`, () => expect(restoreSendMessagePins(history)).toEqual(expected))

test('latest valid identity replaces earlier pin; invalid later receipts cannot replace it', () => {
  const next = { id: B, name: 'PIN-TARGET', ref: subagentRef(B) }
  expect(restoreSendMessagePins([use(), receipt({ success: true, pin }), use('SendMessage', 'second'), receipt({ success: true, pin: next }, 'second'), receipt({ success: false, pin }, 'second')])).toEqual({ 'pin-target': next })
})

test('clear/resume retains names of live tasks and waiting owners, including resumed teammates', () => {
  const s = state([['running', A], ['owner', B], ['idle', 'a1111111111111111'], ['old', 'a2222222222222222'], ['teammate', 'a3333333333333333']])
  s.tasks = {
    [A]: { type: 'local_agent', status: 'running' },
    [B]: { type: 'local_agent', status: 'completed', keepaliveReasons: new Set(['agent:child']) },
    a1111111111111111: { type: 'local_agent', status: 'completed', keepaliveReasons: new Set(['flag:idle-window']) },
    a2222222222222222: { type: 'local_agent', status: 'failed' },
    teammateTask: { type: 'in_process_teammate', status: 'running', identity: { resumableAgentId: 'a3333333333333333' } },
  } as unknown as AppState['tasks']
  expect([...retainLiveAgentNames(s.agentNameRegistry, s.tasks).keys()]).toEqual(['running', 'owner', 'teammate'])
  expect(restoreSendMessagePins([])).toEqual({})
})

test('hash collisions extend discovery refs and reject ambiguous short refs', () => {
  const s = state([['same', 'a0000000000000f39'], ['other', 'a0000000000001310']])
  expect(subagentRef('a0000000000000f39')).toBe('e7ca83')
  expect(subagentRef('a0000000000001310')).toBe('e7ca83')
  expect(resolveSubagentRecipient(s, 'same [e7ca83]')).toBeNull()
  const resolved = resolveSubagentRecipient(s, 'same')
  expect(resolved?.kind).toBe('one')
  if (resolved?.kind === 'one') {
    expect(resolved.recipient.ref.length).toBeGreaterThan(6)
    expect(resolveSubagentRecipient(s, `same [${resolved.recipient.ref}]`)).toEqual(resolved)
  }
})
