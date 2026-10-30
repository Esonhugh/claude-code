import { expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { applyMarkdown } from './markdown.js'

test('an HTML-looking tag in prose is shown as written, like 2.1.311', () => {
  expect(
    stripAnsi(applyMarkdown('Usage: /output-style <style> wraps a <div>', 'dark')),
  ).toBe('Usage: /output-style <style> wraps a <div>')
})
