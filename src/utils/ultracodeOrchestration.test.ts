import assert from 'node:assert/strict'
import {
  findUltracodeTriggerPositions,
  getUltracodeOrchestrationSystemPrompt,
  hasUltracodeKeyword,
  getUltracodeNotificationText,
  shouldInjectUltracodeOrchestration,
} from './ultracodeOrchestration.js'

assert.equal(hasUltracodeKeyword('please ultracode this migration'), true)
assert.equal(hasUltracodeKeyword('what is ultracode?'), false)
assert.equal(findUltracodeTriggerPositions('ultracode this')[0]?.word, 'ultracode')
assert.equal(shouldInjectUltracodeOrchestration('ultracode'), true)
assert.equal(shouldInjectUltracodeOrchestration('high'), false)
assert.equal(shouldInjectUltracodeOrchestration(undefined), false)
assert.equal(
  getUltracodeNotificationText(),
  'Dynamic workflow requested for this turn · opt+w to ignore',
)

const prompt = getUltracodeOrchestrationSystemPrompt()
assert.match(prompt, /dynamic workflow orchestration/)
assert.match(prompt, /Prefer the Workflow tool/)
assert.match(prompt, /deep-research/)
assert.match(prompt, /ultracode/)
assert.match(prompt, /normal permission boundaries/)

console.log('ultracodeOrchestration.test.ts passed')
