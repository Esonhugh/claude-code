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

  // The official hint also lists terminalSequence, which this build does not act on.
  test('the schema hint lists what each event may return', () => {
    const { validationError } = parseHookOutput('{"continue":"yes"}')
    expect(validationError?.split('\n\nExpected schema:\n')[1]).toBe(
      JSON.stringify(
        {
          continue: 'boolean (optional)',
          suppressOutput: 'boolean (optional)',
          stopReason: 'string (optional)',
          decision: '"approve" | "block" (optional)',
          reason: 'string (optional)',
          systemMessage: 'string (optional)',
          hookSpecificOutput: {
            'for PreToolUse': {
              hookEventName: '"PreToolUse"',
              permissionDecision: '"allow" | "deny" | "ask" | "defer" (optional)',
              permissionDecisionReason: 'string (optional)',
              updatedInput: 'object (optional) - Modified tool input to use',
            },
            'for PermissionRequest': {
              hookEventName: '"PermissionRequest"',
              decision: {
                'to allow': {
                  behavior: '"allow"',
                  updatedInput: 'object (optional) - Modified tool input to use',
                  updatedPermissions: 'array (optional) - Permission updates',
                },
                'to deny': {
                  behavior: '"deny"',
                  message: 'string (optional)',
                  interrupt: 'boolean (optional)',
                },
              },
            },
            'for UserPromptSubmit': {
              hookEventName: '"UserPromptSubmit"',
              additionalContext: 'string (optional)',
            },
            'for PostToolUse': {
              hookEventName: '"PostToolUse"',
              additionalContext: 'string (optional)',
            },
            'for PostToolBatch': {
              hookEventName: '"PostToolBatch"',
              additionalContext: 'string (optional)',
            },
            'for Stop / SubagentStop': {
              hookEventName: '"Stop" | "SubagentStop"',
              additionalContext:
                'string (optional) - Feedback for the model; the conversation continues so the model can act on it',
            },
          },
        },
        null,
        2,
      ),
    )
  })
})
