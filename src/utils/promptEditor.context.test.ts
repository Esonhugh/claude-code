import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import instances from '../ink/instances.js'
import { createAssistantMessage, createUserMessage } from './messages.js'
import { editPromptInEditor, getLastResponseText } from './promptEditor.js'

const dir = mkdtempSync(join(tmpdir(), 'prompt-editor-'))
const seen = join(dir, 'seen.txt')
const editor = join(dir, 'editor.sh')
writeFileSync(editor, `#!/bin/sh\ncp "$1" "${seen}"\nprintf 'edited reply' >> "$1"\n`)
chmodSync(editor, 0o755)
const previousVisual = process.env.VISUAL
process.env.VISUAL = editor
const noop = () => {}
instances.set(process.stdout, {
  pause: noop, resume: noop, suspendStdin: noop, resumeStdin: noop,
  enterAlternateScreen: noop, exitAlternateScreen: noop,
} as never)

afterAll(() => {
  instances.delete(process.stdout)
  if (previousVisual === undefined) delete process.env.VISUAL
  else process.env.VISUAL = previousVisual
})

test('last response is the assistant text since the last human prompt', () => {
  const messages = [
    createUserMessage({ content: 'first' }),
    createAssistantMessage({ content: 'old answer' }),
    createUserMessage({ content: 'second' }),
    createAssistantMessage({ content: 'part one' }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }),
    createAssistantMessage({ content: 'part two' }),
  ]
  expect(getLastResponseText(messages)).toBe('part one\n\npart two')
  expect(getLastResponseText([createUserMessage({ content: 'only' })])).toBeUndefined()
})

test('the editor shows the last response as comments and strips them on save', () => {
  const result = editPromptInEditor('draft ', undefined, 'line one\n\nline two')
  expect(readFileSync(seen, 'utf8')).toBe(
    "# ─── Claude's last response (for reference; removed on save) ───\n" +
      '# line one\n#\n# line two\n' +
      '# ─── Write your reply below this line ──────────────────────────\n\ndraft ',
  )
  expect(result.content).toBe('draft edited reply')
})
