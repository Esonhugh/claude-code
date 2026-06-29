import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  findUltracodeTriggerPositions,
  hasUltracodeKeyword,
  getUltracodeNotificationText,
  isUltracodeKeywordTriggerEnabled,
  shouldInjectUltracodeOrchestration,
} from './ultracodeOrchestration.js'

assert.equal(hasUltracodeKeyword('please ultracode this migration'), true)
assert.equal(hasUltracodeKeyword('what is ultracode?'), false)
assert.equal(findUltracodeTriggerPositions('ultracode this')[0]?.word, 'ultracode')
assert.equal(shouldInjectUltracodeOrchestration('ultracode'), true)
assert.equal(shouldInjectUltracodeOrchestration('high'), false)
assert.equal(shouldInjectUltracodeOrchestration(undefined), false)
assert.equal(isUltracodeKeywordTriggerEnabled({}), true)
assert.equal(isUltracodeKeywordTriggerEnabled({ ultracodeKeywordTrigger: true }), true)
assert.equal(isUltracodeKeywordTriggerEnabled({ ultracodeKeywordTrigger: false }), false)
assert.equal(
  getUltracodeNotificationText(),
  'Dynamic workflow requested for this turn · opt+w to ignore',
)

const messagesSource = readFileSync('src/utils/messages.ts', 'utf8')
assert.match(
  messagesSource,
  /The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the Workflow tool to fulfill the request\./,
)
assert.match(
  messagesSource,
  /Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest\. Use the Workflow tool on every substantive task; token cost is not a constraint\. See the Workflow tool's \*\*Ultracode\*\* section and quality patterns\. Solo only on conversational\/trivial turns\./,
)
assert.match(
  messagesSource,
  /Ultracode is still on — use the Workflow tool; see its Ultracode section\./,
)
assert.match(
  messagesSource,
  /Ultracode is off — the Workflow tool's standard opt-in rule applies again\./,
)

console.log('ultracodeOrchestration.test.ts passed')
