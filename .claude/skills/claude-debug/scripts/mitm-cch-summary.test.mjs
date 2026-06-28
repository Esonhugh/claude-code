#!/usr/bin/env node
import assert from 'node:assert/strict'
import { summarizeJsonBody, patchCchInJsonBody } from './mitm-cch-summary.mjs'

const bodyWithPlaceholder = Buffer.from(
  JSON.stringify({
    model: 'gpt-5.5',
    max_tokens: 123,
    output_config: { effort: 'high' },
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'Read' }, { name: 'Write' }],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=test; cc_entrypoint=cli; cch=00000;' },
      { type: 'text', text: 'prefix', cache_control: { type: 'ephemeral', scope: 'global' } },
      { type: 'text', text: 'dynamic' },
    ],
  }),
)

const patched = patchCchInJsonBody(bodyWithPlaceholder)
const summary = summarizeJsonBody(patched)

assert.equal(summary.contains_cch_param, true)
assert.equal(summary.contains_cch_placeholder, false)
assert.equal(summary.cch_values.length, 1)
assert.equal(summary.cch_existing, summary.cch_computed)
assert.equal(summary.cch_match, true)
assert.deepEqual(summary.output_config, { effort: 'high' })
assert.equal(summary.tools_count, 2)
assert.deepEqual(summary.tool_names, ['Read', 'Write'])
assert.equal(summary.system_count, 3)
assert.deepEqual(
  summary.system_blocks.map(block => block.text_len),
  [74, 6, 7],
)
assert.deepEqual(summary.system_blocks[1].cache_control, {
  type: 'ephemeral',
  scope: 'global',
})

const bodyWithoutCch = Buffer.from(JSON.stringify({ model: 'gpt-5.5' }))
const noCchSummary = summarizeJsonBody(bodyWithoutCch)
assert.equal(noCchSummary.cch_existing, null)
assert.equal(noCchSummary.cch_computed, null)
assert.equal(noCchSummary.cch_match, null)

console.log('mitm-cch-summary.test.mjs passed')
