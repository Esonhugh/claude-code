#!/usr/bin/env bun
import { expect, test } from 'bun:test'
import { summarizeJsonBody, patchCchInJsonBody } from './mitm-cch-summary.mjs'

test('summarizes and patches CCH without retaining raw body text', () => {
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

expect(summary.contains_cch_param).toBe(true)
expect(summary.contains_cch_placeholder).toBe(false)
expect(summary.cch_values).toHaveLength(1)
expect(summary.cch_existing).toBe(summary.cch_computed)
expect(summary.cch_match).toBe(true)
expect(summary.output_config).toEqual({ effort: 'high' })
expect(summary.tools_count).toBe(2)
expect(summary.tool_names).toEqual(['Read', 'Write'])
expect(summary.system_count).toBe(3)
expect(summary.system_blocks.map(block => block.text_len)).toEqual([74, 6, 7])
expect(summary.system_blocks[1].cache_control).toEqual({
  type: 'ephemeral',
  scope: 'global',
})
expect(JSON.stringify(summary)).not.toContain('hello')

const bodyWithoutCch = Buffer.from(JSON.stringify({ model: 'gpt-5.5' }))
const noCchSummary = summarizeJsonBody(bodyWithoutCch)
expect(noCchSummary.cch_existing).toBeNull()
expect(noCchSummary.cch_computed).toBeNull()
expect(noCchSummary.cch_match).toBeNull()
})
