import { expect, test } from 'bun:test'
import { unknownToolRuleWarnings } from './permissionSetup.js'

test('deny and ask rules that name no known tool are reported like 2.1.311', () => {
  const known = new Set(['Read', 'Bash'])
  expect(
    unknownToolRuleWarnings(
      {
        alwaysDenyRules: {
          cliArg: ['Read(', 'Bash(rm:*)', 'mcp__srv__tool'],
          session: ['Nope'],
        },
        alwaysAskRules: { userSettings: ['Raed(/etc/**)'] },
      },
      known,
    ),
  ).toEqual([
    'Permission deny rule "Read(" matches no known tool — check for typos.',
    'Permission ask rule "Raed(/etc/**)" matches no known tool — check for typos.',
  ])
})
