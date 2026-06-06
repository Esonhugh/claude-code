import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getWorkflowCompatibilityCases } from './caseMatrix.js'

const expectedCategoryCounts = new Map([
  ['official-export', 20],
  ['general-task', 25],
  ['args', 25],
  ['discovery', 20],
  ['runtime', 20],
  ['control', 15],
  ['error', 15],
  ['long-running', 20],
])

describe('workflow compatibility case matrix', () => {
  it('contains the designed 160 cases with unique stable IDs', () => {
    const cases = getWorkflowCompatibilityCases()
    assert.equal(cases.length, 160)
    assert.equal(new Set(cases.map(testCase => testCase.id)).size, 160)
  })

  it('matches the designed category distribution', () => {
    const cases = getWorkflowCompatibilityCases()
    for (const [category, expectedCount] of expectedCategoryCounts) {
      assert.equal(
        cases.filter(testCase => testCase.category === category).length,
        expectedCount,
        category,
      )
    }
  })

  it('does not shadow built-in workflows in official export probes', () => {
    const cases = getWorkflowCompatibilityCases().filter(testCase => testCase.category === 'official-export')
    for (const testCase of cases) {
      assert.deepEqual(testCase.fixtureFiles, {})
    }
  })

  it('sets execution guardrails on every case', () => {
    for (const testCase of getWorkflowCompatibilityCases()) {
      assert.match(testCase.id, /^[A-Z]+-\d{3}$/)
      assert.ok(testCase.title.length > 0)
      assert.ok(testCase.prompt.length > 0)
      assert.ok(testCase.timeoutMs >= 30000)
      assert.ok(testCase.maxOutputBytes >= 50000)
      assert.ok(testCase.confirmation.rerunsOnDifference >= 2)
      assert.ok(Array.isArray(testCase.comparison.requiredEventTypes))
      assert.ok(Array.isArray(testCase.comparison.proseFields))
    }
  })
})
