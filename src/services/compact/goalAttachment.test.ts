#!/usr/bin/env node
import assert from 'node:assert/strict'

import { createGoalAttachmentIfNeeded } from './compact.js'

function reminderContent(att: ReturnType<typeof createGoalAttachmentIfNeeded>): string {
  assert.ok(att)
  assert.equal(att.type, 'attachment')
  assert.equal(att.attachment.type, 'critical_system_reminder')
  return (att.attachment as { content: string }).content
}

assert.equal(createGoalAttachmentIfNeeded({ active: false } as never), null)

const activeContent = reminderContent(
  createGoalAttachmentIfNeeded({
    active: true,
    prompt: 'finish workflow validation inside built-claude',
  } as never),
)
assert.match(activeContent, /still running in \/goal mode/)
assert.match(activeContent, /finish workflow validation inside built-claude/)
assert.match(activeContent, /StopHook/)

const fallbackContent = reminderContent(
  createGoalAttachmentIfNeeded({ active: true } as never),
)
assert.match(fallbackContent, /\(no goal provided\)/)

console.log('goalAttachment.test.ts passed')

