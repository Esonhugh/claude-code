import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/utils/processUserInput/processUserInput.ts', 'utf8')

assert.match(
  source,
  /isUltracodeKeywordTriggerEnabled\(context\.getAppState\(\)\.settings\)/,
  'processUserInputBase must read ultracode settings from context.getAppState(); appState is scoped only to processUserInput and causes plain prompts to abort before onQuery',
)
assert.match(
  source,
  /workflow_keyword_request/,
  'ultracode keyword turns must attach the workflow reminder for the model-visible turn',
)

console.log('processUserInput.test.ts passed')
