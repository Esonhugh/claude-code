import { expect, test } from 'bun:test'
import { cleanAssistantDisplayText } from './assistantDisplayText.js'

test.each([
  ['leading newlines only', '\n\n  body  \n', '  body  \n'],
  ['analysis blocks', '<context>private\nbody</context>\nVisible<pr_analysis>private</pr_analysis>', 'Visible'],
  ['matching closing tags', '<context>left</commit_analysis>', '<context>left</commit_analysis>'],
  ['case sensitive analysis', '<Context>body</Context>', '<Context>body</Context>'],
  ['memory wrappers preserve content', '<cc-memory owner="a">body</cc-memory>', 'body'],
  ['supported memory spellings', '<cc_memory>A</ccmemory><CC-MEMORY>B</CC_MEMORY><CCMEMORY/>C', 'ABC'],
  ['mixed case is not a memory tag', '<Cc-Memory>body</Cc-Memory>', '<Cc-Memory>body</Cc-Memory>'],
  ['similarly named tags stay', '<cc-memory-other>body</cc-memory-other>', '<cc-memory-other>body</cc-memory-other>'],
  ['attribute length bound', '<cc-memory '+ 'x'.repeat(1024) +'>body</cc-memory>', '<cc-memory '+ 'x'.repeat(1024) +'>body'],
  ['Unicode and CRLF', '\n\r\n你好 🧪 \r\n', '\r\n你好 🧪 \r\n'],
])('official display projection: %s', (_label,input,output) => {
  expect(cleanAssistantDisplayText(input)).toBe(output)
})
