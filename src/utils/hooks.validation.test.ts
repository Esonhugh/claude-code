import { describe, expect, test } from 'bun:test'
import { parseHookOutput } from './hooks.js'

function firstLine(stdout: unknown): string {
  const { validationError } = parseHookOutput(JSON.stringify(stdout))
  return validationError?.split('\n')[0] ?? ''
}

describe('hook JSON validation messages (official 2.1.329)', () => {
  test('names the field the PreToolUse output got wrong', () => {
    expect(
      firstLine({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'maybe',
        },
      }),
    ).toBe(
      'Hook JSON output validation failed \u2014 hookSpecificOutput.permissionDecision: Invalid option: expected one of "allow"|"deny"|"ask"|"defer"',
    )
  })

  test('reports a missing hookEventName', () => {
    expect(firstLine({ hookSpecificOutput: { additionalContext: 'x' } })).toBe(
      'Hook JSON output validation failed \u2014 hookSpecificOutput is missing required field "hookEventName"',
    )
  })

  test('keeps the output and the schema hint after the summary', () => {
    const { validationError, plainText } = parseHookOutput(
      '{"continue":"yes"}',
    )
    expect(plainText).toBe('{"continue":"yes"}')
    expect(validationError).toStartWith(
      'Hook JSON output validation failed \u2014 continue: expected boolean, received string',
    )
    expect(validationError).toContain(
      `\n\nThe hook's output was: {\n  "continue": "yes"\n}\n\nExpected schema:\n`,
    )
  })
})
