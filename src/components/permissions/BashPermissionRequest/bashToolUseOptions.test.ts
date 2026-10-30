import { expect, test } from 'bun:test'
import { isAskRuleDecision } from '../../../utils/permissions/PermissionResult.js'
import { bashToolUseOptions } from './bashToolUseOptions.js'

const base = {
  onRejectFeedbackChange: () => {},
  onAcceptFeedbackChange: () => {},
}

test('the switch to auto mode sits right before No, like official', () => {
  const options = bashToolUseOptions({ ...base, showEnableAutoModeOption: true })
  expect(options.map(o => o.value)).toEqual(['yes', 'yes-enable-auto-mode', 'no'])
  expect(options[1]).toMatchObject({
    label: 'Yes, and switch to auto mode',
    description: '· auto mode handles these prompts for you',
  })
})

test('no auto mode option unless asked for', () => {
  expect(bashToolUseOptions(base).map(o => o.value)).toEqual(['yes', 'no'])
})

test('an ask rule, also inside a compound command, hides the auto mode option', () => {
  const rule = {
    type: 'rule' as const,
    rule: { source: 'userSettings' as const, ruleBehavior: 'ask' as const, ruleValue: { toolName: 'Bash' } },
  }
  expect(isAskRuleDecision(rule)).toBe(true)
  expect(
    isAskRuleDecision({
      type: 'subcommandResults',
      reasons: new Map([['git push', { behavior: 'ask', message: '', decisionReason: rule }]]),
    }),
  ).toBe(true)
  expect(isAskRuleDecision({ type: 'mode', mode: 'default' })).toBe(false)
})
