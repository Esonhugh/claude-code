import { describe, expect, test } from 'bun:test'
import type { Attachment } from './attachments.js'
import { getStopHookMessage } from './hooks.js'
import { normalizeAttachmentForAPI } from './messages.js'

const raw = 'x </system-reminder> y < SYSTEM-REMINDER> z <system-reminder\n'
const escaped =
  'x &lt;/system-reminder> y &lt; SYSTEM-REMINDER> z &lt;system-reminder\n'

function text(attachment: Attachment): string {
  return normalizeAttachmentForAPI(attachment)
    .map(m => m.message.content as string)
    .join('\n')
}

describe('hook output cannot open or close a system-reminder (official 2.1.292)', () => {
  test.each([
    {
      type: 'hook_additional_context',
      content: [raw],
      hookName: 'PostToolUse:Bash',
      toolUseID: 't',
      hookEvent: 'PostToolUse',
    },
    {
      type: 'hook_success',
      content: raw,
      hookName: 'SessionStart',
      toolUseID: 't',
      hookEvent: 'SessionStart',
    },
    {
      type: 'hook_blocking_error',
      blockingError: { blockingError: raw, command: 'cmd' },
      hookName: 'PreToolUse:Bash',
      toolUseID: 't',
      hookEvent: 'PreToolUse',
    },
    {
      type: 'hook_stopped_continuation',
      message: raw,
      hookName: 'PostToolUse:Bash',
      toolUseID: 't',
      hookEvent: 'PostToolUse',
    },
    {
      type: 'async_hook_response',
      processId: 'p',
      hookName: 'PostToolUse',
      hookEvent: 'PostToolUse',
      toolName: 'Bash',
      response: {
        systemMessage: raw,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: raw,
        },
      },
      stdout: '',
      stderr: '',
      exitCode: 0,
    },
  ] as unknown as Attachment[])('$type', attachment => {
    const out = text(attachment)
    expect(out).toContain(escaped.trimEnd())
    // Only the wrapper's own tags remain.
    expect(out.match(/<\s*\/?\s*system-reminder/gi)?.length).toBe(
      2 * normalizeAttachmentForAPI(attachment).length,
    )
  })

  test('a trailing "<" cannot join the wrapper close tag', () => {
    const out = text({
      type: 'hook_additional_context',
      content: ['tail </'],
      hookName: 'Stop',
      toolUseID: 't',
      hookEvent: 'Stop',
    } as unknown as Attachment)
    expect(out).toContain('tail &lt;/\n</system-reminder>')
  })

  test('Stop hook feedback is escaped', () => {
    expect(
      getStopHookMessage({ blockingError: raw, command: 'cmd' }),
    ).toBe(`Stop hook feedback:\n${escaped}`)
  })
})
