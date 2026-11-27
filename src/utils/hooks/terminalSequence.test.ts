import { afterEach, beforeEach, expect, test } from 'bun:test'
import { env } from '../env.js'
import {
  registerHookTerminalWriter,
  sanitizeTerminalSequence,
  writeHookTerminalSequence,
} from './terminalSequence.js'

const saved = { terminal: env.terminal, TMUX: process.env.TMUX, STY: process.env.STY }

function restore(name: 'TMUX' | 'STY') {
  if (saved[name] === undefined) delete process.env[name]
  else process.env[name] = saved[name]
}

beforeEach(() => {
  env.terminal = 'xterm-256color'
  delete process.env.TMUX
  delete process.env.STY
})

afterEach(() => {
  env.terminal = saved.terminal
  restore('TMUX')
  restore('STY')
})

// Official 2.1.329 `MDr`: titles, notifications and BEL pass, each rebuilt for this terminal.
test('title, notification and bell sequences are rebuilt', () => {
  expect(sanitizeTerminalSequence('\x1b]0;work\x07')).toBe('\x1b]0;work\x07')
  expect(sanitizeTerminalSequence('\x1b]2;work\x1b\\')).toBe('\x1b]2;work\x07')
  expect(sanitizeTerminalSequence('\x1b]9;Build done\x07')).toBe('\x1b]9;Build done\x07')
  expect(sanitizeTerminalSequence('\x1b]777;notify;Claude;done\x07\x07')).toBe('\x1b]777;notify;Claude;done\x07\x07')
  expect(sanitizeTerminalSequence('\x07')).toBe('\x07')
  expect(sanitizeTerminalSequence('\x1b]1\x07')).toBe('\x1b]1;\x07')
})

test('kitty notifications end with ST', () => {
  expect(sanitizeTerminalSequence('\x1b]99;;hi\x07')).toBe('\x1b]99;;hi\x1b\\')
  env.terminal = 'kitty'
  expect(sanitizeTerminalSequence('\x1b]2;work\x07')).toBe('\x1b]2;work\x1b\\')
})

test('inside tmux the rebuilt sequence is passed through', () => {
  process.env.TMUX = '/tmp/tmux-501/default,1,0'
  expect(sanitizeTerminalSequence('\x1b]2;work\x07')).toBe('\x1bPtmux;\x1b\x1b]2;work\x07\x1b\\')
})

test('controls inside the payload are dropped', () => {
  expect(sanitizeTerminalSequence('\x1b]2;a\x00b\x7fc\x9bd\x07')).toBe('\x1b]2;abcd\x07')
})

test('OSC 9 is allowed as progress but not as another ConEmu command', () => {
  expect(sanitizeTerminalSequence('\x1b]9;4;1;50\x07')).toBe('\x1b]9;4;1;50\x07')
  expect(sanitizeTerminalSequence('\x1b]9;4;0\x07')).toBe('\x1b]9;4;0\x07')
  expect(sanitizeTerminalSequence('\x1b]9;9;C:\\\x07')).toBeNull()
  expect(sanitizeTerminalSequence('\x1b]9; \u200b+1 left\x07')).toBeNull()
  expect(sanitizeTerminalSequence('\x1b]9;4;1;101\x07')).toBeNull()
})

test('anything outside the allowlist drops the whole sequence', () => {
  expect(sanitizeTerminalSequence('')).toBeNull()
  expect(sanitizeTerminalSequence('\x1b]52;c;aGk=\x07')).toBeNull()
  expect(sanitizeTerminalSequence('\x1b]2;ok\x07\x1b]52;c;aGk=\x07')).toBeNull()
  expect(sanitizeTerminalSequence('\x1b]8;;https://x\x07')).toBeNull()
  expect(sanitizeTerminalSequence('\x1b[2J')).toBeNull()
  expect(sanitizeTerminalSequence('plain text')).toBeNull()
  expect(sanitizeTerminalSequence('\x1b]2;unterminated')).toBeNull()
  expect(sanitizeTerminalSequence('\x1b]2;a\x1b[31mb\x07')).toBeNull()
  expect(sanitizeTerminalSequence('\x1b]x;title\x07')).toBeNull()
  expect(sanitizeTerminalSequence(`\x1b]2;${'é'.repeat(2047)}\x07`)).toBeNull()
  expect(sanitizeTerminalSequence(`\x1b]2;${'é'.repeat(2045)}\x07`)).not.toBeNull()
})

test('sequences go to the most recently registered writer', () => {
  const first: string[] = []
  const second: string[] = []
  const unregisterFirst = registerHookTerminalWriter(data => first.push(data))
  const unregisterSecond = registerHookTerminalWriter(data => second.push(data))
  writeHookTerminalSequence('a')
  unregisterSecond()
  writeHookTerminalSequence('b')
  unregisterFirst()
  writeHookTerminalSequence('c')
  expect(first).toEqual(['b'])
  expect(second).toEqual(['a'])
})
