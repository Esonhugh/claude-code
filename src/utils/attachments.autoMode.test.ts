import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { Message } from '../types/message.js'

const attachmentsSource = readFileSync(
  new URL('./attachments.ts', import.meta.url),
  'utf8',
)

function autoModeTurnCount(
  messages: Message[],
  scope: 'execution' | 'plan-permissions',
): { turnCount: number; foundAutoModeAttachment: boolean } {
  let turnCount = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'user' && !message.isMeta) {
      turnCount++
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'auto_mode'
    ) {
      return {
        turnCount,
        foundAutoModeAttachment:
          (message.attachment.scope ?? 'execution') === scope,
      }
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'auto_mode_exit'
    ) {
      break
    }
  }

  return { turnCount, foundAutoModeAttachment: false }
}

function autoModeAttachment(
  scope?: 'execution' | 'plan-permissions',
): Message {
  return {
    type: 'attachment',
    attachment: {
      type: 'auto_mode',
      reminderType: 'full',
      ...(scope === undefined ? {} : { scope }),
    },
  } as Message
}

describe('auto mode attachment throttling', () => {
  test('passes the active scope into reminder throttling and cadence', () => {
    expect(attachmentsSource).toContain(
      'getAutoModeAttachmentTurnCount(messages, scope)',
    )
    expect(attachmentsSource).toContain(
      'countAutoModeAttachmentsSinceLastExit(messages ?? [], scope)',
    )
    expect(attachmentsSource).toContain("return attachment.scope ?? 'execution'")
  })

  test('throttles reminders within the same scope', () => {
    expect(
      autoModeTurnCount(
        [autoModeAttachment('plan-permissions')],
        'plan-permissions',
      ),
    ).toEqual({ turnCount: 0, foundAutoModeAttachment: true })
  })

  test('resets throttling when execution auto enters plan mode', () => {
    expect(
      autoModeTurnCount(
        [autoModeAttachment('execution')],
        'plan-permissions',
      ),
    ).toEqual({ turnCount: 0, foundAutoModeAttachment: false })
  })

  test('treats legacy reminders as execution scope', () => {
    expect(
      autoModeTurnCount([autoModeAttachment()], 'execution'),
    ).toEqual({ turnCount: 0, foundAutoModeAttachment: true })
  })
})
