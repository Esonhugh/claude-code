#!/usr/bin/env node
import assert from 'node:assert/strict'

const { computeCch, patchCchInRequestBody } = await import(
  './cchAttestation.js'
)

const mekaFixture = [
  '{"system":[{"type":"text","text":"x-anthropic-billing-header: ',
  'cc_version=2.1.185.abc; cc_entrypoint=cli; cch=00000;"}],"model"',
  ':"claude-opus-4-20250514","max_tokens":1024,"messages":[{"role"',
  ':"user","content":"hi"}]}',
].join('')

assert.equal(
  patchCchInRequestBody(mekaFixture),
  mekaFixture.replace('cch=00000', 'cch=16a13'),
)
assert.equal(computeCch(mekaFixture), '16a13')

const bodyWithMessagePlaceholder = JSON.stringify({
  system: [
    {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2.1.185.abc; cc_entrypoint=cli; cch=00000;',
    },
  ],
  model: 'claude-sonnet-4-6',
  messages: [
    { role: 'user', content: 'please keep literal cch=00000 in this message' },
  ],
  max_tokens: 1024,
})
const patchedMessageBody = patchCchInRequestBody(bodyWithMessagePlaceholder)
assert.match(
  patchedMessageBody,
  /x-anthropic-billing-header:[^\n]*cch=[0-9a-f]{5};/,
)
assert.equal((patchedMessageBody.match(/cch=00000/g) ?? []).length, 1)
assert.ok(patchedMessageBody.includes('literal cch=00000 in this message'))

const noBillingHeader = JSON.stringify({
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hello' }],
})
assert.equal(patchCchInRequestBody(noBillingHeader), noBillingHeader)

const base = JSON.stringify({
  system: [
    {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2.1.185.abc; cc_entrypoint=cli; cch=00000;',
    },
  ],
  model: 'claude-a',
  messages: [{ role: 'user', content: 'hello' }],
})
const variant = JSON.stringify({
  system: [
    {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2.1.185.abc; cc_entrypoint=cli; cch=00000;',
    },
  ],
  model: 'claude-b',
  max_tokens: 64000,
  fallbacks: ['fallback-model'],
  fallback_credit_token: 'secret-credit-token',
  messages: [{ role: 'user', content: 'hello' }],
})
assert.equal(computeCch(base), computeCch(variant))

console.log('cchAttestation.test.ts passed')
