import { expect, test } from 'bun:test'

import { matchWildcardPattern, parsePermissionRule, suggestionForPrefix } from './shellRuleMatching.js'

test('prefix suggestions use the space syntax like 2.1.311, which still matches the bare command', () => {
  const [update] = suggestionForPrefix('Bash', 'git status')
  expect(update).toMatchObject({ rules: [{ toolName: 'Bash', ruleContent: 'git status *' }] })
  const rule = parsePermissionRule('git status *')
  expect(rule.type).toBe('wildcard')
  expect(matchWildcardPattern('git status *', 'git status')).toBe(true)
  expect(matchWildcardPattern('git status *', 'git status --short')).toBe(true)
  expect(matchWildcardPattern('git status *', 'git statusx')).toBe(false)
})
