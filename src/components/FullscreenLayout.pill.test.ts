import { expect, test } from 'bun:test'
import { newMessagesPillLabel } from './FullscreenLayout.js'

test('pill shows the scroll:bottom shortcut like official', () => {
  expect(newMessagesPillLabel(0, 'ctrl+End', 'PageDown', 'linux')).toBe('Jump to bottom (ctrl+End) ↓')
  expect(newMessagesPillLabel(1, 'ctrl+End', 'PageDown', 'windows')).toBe('1 new message (ctrl+End) ↓')
  expect(newMessagesPillLabel(3, 'ctrl+g', 'PageDown', 'linux')).toBe('3 new messages (ctrl+g) ↓')
})

test('pill on macOS with the default binding points at fn+↓', () => {
  expect(newMessagesPillLabel(0, 'ctrl+End', 'PageDown', 'macos')).toBe('Jump to bottom: fn+↓ to scroll')
  expect(newMessagesPillLabel(2, 'ctrl+End', 'ctrl+d', 'macos')).toBe('2 new messages: ctrl+d to scroll')
  expect(newMessagesPillLabel(0, 'ctrl+g', 'PageDown', 'macos')).toBe('Jump to bottom (ctrl+g) ↓')
})
