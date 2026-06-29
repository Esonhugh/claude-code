#!/usr/bin/env node
import assert from 'node:assert/strict'

import { createGoalAttachmentIfNeeded } from './compact.js'

const inactiveContext = {
  getAppState: () => ({ goalStatus: { active: false } }),
} as never

assert.equal(createGoalAttachmentIfNeeded(inactiveContext), null)

const activeContext = {
  getAppState: () => ({
    goalStatus: {
      active: true,
      prompt: 'finish workflow validation inside built-claude',
    },
  }),
} as never

const attachment = createGoalAttachmentIfNeeded(activeContext)
assert.ok(attachment)
assert.equal(attachment.type, 'attachment')
assert.equal(attachment.attachment.type, 'critical_system_reminder')
assert.match(attachment.attachment.content, /still running in \/goal mode/)
assert.match(attachment.attachment.content, /finish workflow validation inside built-claude/)
assert.match(attachment.attachment.content, /StopHook/)

console.log('goalAttachment.test.ts passed')
