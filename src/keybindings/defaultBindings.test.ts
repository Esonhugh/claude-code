import { expect, test } from 'bun:test'
import { InputEvent } from '../ink/events/input-event.js'
import { INITIAL_STATE, parseMultipleKeypresses } from '../ink/parse-keypress.js'
import { DEFAULT_BINDINGS } from './defaultBindings.js'
import { parseBindings } from './parser.js'
import { resolveKey, resolveKeyWithChordState } from './resolver.js'
import { KEYBINDING_ACTIONS, KeybindingsSchema } from './schema.js'

function inputEvent(sequence: string): InputEvent {
  const [keys] = parseMultipleKeypresses(INITIAL_STATE, sequence)
  expect(keys).toHaveLength(1)
  const keypress = keys[0]
  if (keypress?.kind !== 'key') throw new Error('Expected a key event')
  return new InputEvent(keypress)
}

test('chat queue submission is a public action bound to ctrl+x enter', () => {
  expect(KEYBINDING_ACTIONS).toContain('chat:queueSubmit')
  expect(
    DEFAULT_BINDINGS.find(block => block.context === 'Chat')?.bindings[
      'ctrl+x enter'
    ],
  ).toBe('chat:queueSubmit')
})

test('diff list shortcuts are public global actions for Ctrl and Option arrows', () => {
  const bindings = parseBindings(DEFAULT_BINDINGS)
  for (const [sequence, action] of [
    ['\x1b[1;5A', 'app:diffFileListUp'],
    ['\x1b[1;5B', 'app:diffFileListDown'],
    ['\x1b[1;3A', 'app:diffFileListUp'],
    ['\x1b[1;3B', 'app:diffFileListDown'],
  ] as const) {
    const event = inputEvent(sequence)
    expect(
      resolveKey(event.input, event.key, ['Chat', 'Global'], bindings),
    ).toEqual({ type: 'match', action })
    expect(KEYBINDING_ACTIONS).toContain(action)
  }
})

test('diff base cycling is a public global action bound to ctrl+x b', () => {
  const bindings = parseBindings(DEFAULT_BINDINGS)
  const prefix = inputEvent('\x18')
  const first = resolveKeyWithChordState(
    prefix.input,
    prefix.key,
    ['Chat', 'Global'],
    bindings,
    null,
  )
  expect(first.type).toBe('chord_started')
  if (first.type !== 'chord_started') throw new Error('Expected chord prefix')
  const next = inputEvent('b')
  expect(
    resolveKeyWithChordState(
      next.input,
      next.key,
      ['Chat', 'Global'],
      bindings,
      first.pending,
    ),
  ).toEqual({ type: 'match', action: 'app:cycleDiffBase' })
  expect(KEYBINDING_ACTIONS).toContain('app:cycleDiffBase')
})

test('diff actions can be rebound through the public keybindings schema', () => {
  const config = KeybindingsSchema().parse({
    bindings: [
      {
        context: 'Global',
        bindings: {
          'ctrl+n': 'app:diffFileListDown',
          'ctrl+p': 'app:diffFileListUp',
          'ctrl+g': 'app:cycleDiffBase',
        },
      },
    ],
  })
  const bindings = parseBindings([...DEFAULT_BINDINGS, ...config.bindings])
  for (const [sequence, action] of [
    ['\x0e', 'app:diffFileListDown'],
    ['\x10', 'app:diffFileListUp'],
    ['\x07', 'app:cycleDiffBase'],
  ] as const) {
    const event = inputEvent(sequence)
    expect(
      resolveKey(event.input, event.key, ['Chat', 'Global'], bindings),
    ).toEqual({ type: 'match', action })
  }
})

test('diff list defaults honor user overrides and null unbinding', () => {
  for (const [shortcut, sequence] of [
    ['ctrl+up', '\x1b[1;5A'],
    ['ctrl+down', '\x1b[1;5B'],
    ['opt+up', '\x1b[1;3A'],
    ['opt+down', '\x1b[1;3B'],
  ] as const) {
    for (const action of ['command:help', null]) {
      const config = KeybindingsSchema().parse({
        bindings: [{ context: 'Global', bindings: { [shortcut]: action } }],
      })
      const bindings = parseBindings([...DEFAULT_BINDINGS, ...config.bindings])
      const event = inputEvent(sequence)
      expect(
        resolveKey(event.input, event.key, ['Chat', 'Global'], bindings),
      ).toEqual(action === null ? { type: 'unbound' } : { type: 'match', action })
    }
  }
})

test('diff base chord honors overrides and null unbinding without reserving its prefix', () => {
  for (const action of ['command:help', null]) {
    const config = KeybindingsSchema().parse({
      bindings: [{ context: 'Global', bindings: { 'ctrl+x b': action } }],
    })
    const bindings = parseBindings([...DEFAULT_BINDINGS, ...config.bindings])
    const prefix = inputEvent('\x18')
    const first = resolveKeyWithChordState(
      prefix.input,
      prefix.key,
      ['Chat', 'Global'],
      bindings,
      null,
    )
    expect(first.type).toBe('chord_started')
    if (first.type !== 'chord_started') {
      throw new Error('Expected Chat chord prefix')
    }
    const next = inputEvent('b')
    expect(
      resolveKeyWithChordState(
        next.input,
        next.key,
        ['Chat', 'Global'],
        bindings,
        first.pending,
      ),
    ).toEqual(action === null ? { type: 'unbound' } : { type: 'match', action })
    if (action === null) {
      expect(
        resolveKeyWithChordState(
          prefix.input,
          prefix.key,
          ['Global'],
          bindings,
          null,
        ),
      ).toEqual({ type: 'none' })
    }
  }
})

test('wheel pointer coordinates survive split sequences and orphan recovery', () => {
  for (const sequence of ['\x1b[<80;1;1M', '\x1b[Mp!!']) {
    for (let split = 1; split < sequence.length; split++) {
      const [before, state] = parseMultipleKeypresses(
        INITIAL_STATE,
        sequence.slice(0, split),
      )
      expect(before).toEqual([])
      const [keys, nextState] = parseMultipleKeypresses(
        state,
        sequence.slice(split),
      )
      expect(keys).toMatchObject([
        { kind: 'key', name: 'wheelup', pointer: { column: 0, row: 0 } },
      ])
      expect(nextState.incomplete).toBe('')
    }
    const [recovered] = parseMultipleKeypresses(INITIAL_STATE, sequence.slice(1))
    expect(recovered).toMatchObject([
      { kind: 'key', name: 'wheelup', pointer: { column: 0, row: 0 } },
    ])
  }
})

test('modified wheels keep scroll bindings and expose pointer through InputEvent', () => {
  const bindings = parseBindings(DEFAULT_BINDINGS)
  for (const [sequence, action, pointer] of [
    ['\x1b[<92;301;55M', 'scroll:lineUp', { column: 300, row: 54 }],
    ['\x1b[M}!u', 'scroll:lineDown', { column: 0, row: 84 }],
  ] as const) {
    const event = inputEvent(sequence)
    expect(event.keypress.pointer).toEqual(pointer)
    expect(event.input).toBe('')
    expect(resolveKey(event.input, event.key, ['Scroll'], bindings)).toEqual({
      type: 'match',
      action,
    })
  }
})

test('non-wheel input and paste do not acquire wheel pointer coordinates', () => {
  for (const sequence of [
    'a',
    '\x1b[A',
    '\x1b[M !!',
    '\x1b[200~\x1b[<64;8;9M\x1b[201~',
  ]) {
    const event = inputEvent(sequence)
    expect(event.keypress.pointer).toBeUndefined()
  }
  for (const terminator of ['M', 'm']) {
    const sequence = `\x1b[<0;8;9${terminator}`
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, sequence)
    expect(keys).toEqual([
      {
        kind: 'mouse',
        button: 0,
        action: terminator === 'M' ? 'press' : 'release',
        col: 8,
        row: 9,
        sequence,
      },
    ])
  }
})

test('X10 wheel keys retain zero-based pointer coordinates with modifiers', () => {
  for (const modifiers of [0, 4, 8, 12, 16, 20, 24, 28]) {
    for (const [direction, name] of ['wheelup', 'wheeldown'].entries()) {
      const sequence = `\x1b[M${String.fromCharCode(64 + direction + modifiers + 32, 80 + 32, 12 + 32)}`
      const [keys] = parseMultipleKeypresses(INITIAL_STATE, sequence)
      expect(keys).toMatchObject([
        {
          kind: 'key',
          name,
          pointer: { column: 79, row: 11 },
          sequence,
          raw: sequence,
        },
      ])
    }
  }
})

test('SGR wheel keys retain zero-based pointer coordinates with modifiers', () => {
  for (const modifiers of [0, 4, 8, 12, 16, 20, 24, 28]) {
    for (const [direction, name] of ['wheelup', 'wheeldown'].entries()) {
      const sequence = `\x1b[<${64 + direction + modifiers};121;9M`
      const [keys] = parseMultipleKeypresses(INITIAL_STATE, sequence)
      expect(keys).toMatchObject([
        {
          kind: 'key',
          name,
          pointer: { column: 120, row: 8 },
          sequence,
          raw: sequence,
        },
      ])
    }
  }
})
