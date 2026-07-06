import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  findUltracodeTriggerPositions,
  hasUltracodeKeyword,
  getUltracodeNotificationText,
  getUltracodeNotificationTriggerPositions,
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
assert.deepEqual(
  getUltracodeNotificationTriggerPositions('please ultracode this', {}).map(
    position => position.start,
  ),
  [7],
)
assert.deepEqual(
  getUltracodeNotificationTriggerPositions('please ultracode this', {
    ultracodeKeywordTrigger: true,
  }).map(position => position.start),
  [7],
)
assert.deepEqual(
  getUltracodeNotificationTriggerPositions('please ultracode this', {
    ultracodeKeywordTrigger: false,
  }),
  [],
)
assert.deepEqual(
  getUltracodeNotificationTriggerPositions('what is ultracode?', {}),
  [],
)
assert.equal(
  getUltracodeNotificationText(),
  'Dynamic workflow requested for this turn · opt+w to ignore',
)

const messagesSource = readFileSync('src/utils/messages.ts', 'utf8')
assert.match(messagesSource, /deeper verification/)
assert.match(messagesSource, /workflow-scale orchestration/)
assert.match(messagesSource, /For focused tasks/)
assert.match(messagesSource, /do not call Workflow/)
assert.doesNotMatch(
  messagesSource,
  /use the Workflow tool to fulfill the request/,
)
assert.doesNotMatch(
  messagesSource,
  /Use the Workflow tool on every substantive task/,
)
assert.doesNotMatch(
  messagesSource,
  /Ultracode is still on — use the Workflow tool/,
)
assert.match(
  messagesSource,
  /Ultracode is off — the Workflow tool's standard opt-in rule applies again\./,
)

console.log('ultracodeOrchestration.test.ts passed')
