import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalFixtureRoot = process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT
const originalRecord = process.env.VCR_RECORD
const fixtureRoot = await mkdtemp(join(tmpdir(), 'token-vcr-model-'))
process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixtureRoot
// Record into the temp root even under CI, which otherwise refuses missing fixtures.
process.env.VCR_RECORD = '1'

const { withTokenCountVCR } = await import('./vcr.js')

afterAll(async () => {
  if (originalRecord === undefined) delete process.env.VCR_RECORD
  else process.env.VCR_RECORD = originalRecord
  if (originalFixtureRoot === undefined) {
    delete process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT
  } else {
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = originalFixtureRoot
  }
  await rm(fixtureRoot, { recursive: true, force: true })
})

test('separates token-count fixtures by model', async () => {
  const messages = [{ role: 'user', content: 'same input' }]

  expect(await withTokenCountVCR(messages, [], 'model-a', async () => 11)).toBe(11)
  expect(await withTokenCountVCR(messages, [], 'model-b', async () => 22)).toBe(22)
  expect(await withTokenCountVCR(messages, [], 'model-a', async () => 99)).toBe(11)
})
