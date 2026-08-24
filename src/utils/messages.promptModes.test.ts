import { describe, expect, test } from 'bun:test'
import { normalizeAttachmentForAPI } from './messages.js'
import type { Attachment } from './attachments.js'

function textFor(attachment: Attachment): string {
  return normalizeAttachmentForAPI(attachment)
    .map(message => message.message.content)
    .filter((content): content is string => typeof content === 'string')
    .join('\n')
}

describe('mode prompt behavior', () => {
  test('keeps autonomous execution guidance in regular auto mode', () => {
    const prompt = textFor({
      type: 'auto_mode',
      reminderType: 'full',
      scope: 'execution',
    })

    expect(prompt).toContain('Execute immediately')
    expect(prompt).toContain('When in doubt, start coding')
  })

  test('limits plan-with-auto guidance to permission classification', () => {
    const prompt = textFor({
      type: 'auto_mode',
      reminderType: 'full',
      scope: 'plan-permissions',
    })

    expect(prompt).toContain('Plan mode remains active')
    expect(prompt).toContain('permission classifier')
    expect(prompt).not.toContain('Execute immediately')
    expect(prompt).not.toContain('start coding')
  })

  test('keeps legacy auto attachments in execution scope', () => {
    const prompt = textFor({
      type: 'auto_mode',
      reminderType: 'full',
    })

    expect(prompt).toContain('Execute immediately')
    expect(prompt).toContain('When in doubt, start coding')
  })

  test('states the plan-file exception consistently for subagents', () => {
    const planFilePath = '/tmp/session-plan.md'
    const prompt = textFor({
      type: 'plan_mode',
      reminderType: 'full',
      isSubAgent: true,
      planFilePath,
      planExists: false,
    })

    expect(prompt).toContain('MUST NOT make any edits except to the plan file')
    expect(prompt).toContain(planFilePath)
    expect(prompt).not.toContain('MUST NOT make any edits, run any non-readonly tools')
  })
})
