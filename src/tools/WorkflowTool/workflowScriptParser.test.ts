import assert from 'node:assert/strict'

import {
  parseWorkflowScript,
  WorkflowScriptParseError,
} from './workflowScriptParser.js'

const validScript = `export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  title: 'Find flaky tests',
  whenToUse: 'When CI is flaky',
  phases: [
    { title: 'Scan', detail: 'grep logs', model: 'claude-sonnet-4-6' },
    { title: 'Verify' },
  ],
}

phase('Scan')
const flaky = await agent('Find flaky tests')
return flaky
`

const cases: Array<[string, RegExp]> = [
  ['const x = 1\nexport const meta = { name: "x", description: "y" }', /must be the FIRST statement/],
  ['export let meta = { name: "x", description: "y" }', /export const meta/],
  ['export const meta = { name: "", description: "y" }', /meta\.name/],
  ['export const meta = { name: "x", description: "" }', /meta\.description/],
  ['export const meta = { name: "x", description: "y", value: compute() }', /pure literal/],
  ['export const meta = { name: "x", description: "y", ...extra }', /pure literal/],
  ['export const meta = { name: `x ${value}`, description: "y" }', /pure literal/],
  ['export const meta = { ["name"]: "x", description: "y" }', /pure literal/],
  ['export const meta: any = { name: "x", description: "y" }', /plain JavaScript/],
]

const parsed = parseWorkflowScript(validScript)
assert.deepEqual(parsed.meta, {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  title: 'Find flaky tests',
  whenToUse: 'When CI is flaky',
  phases: [
    { title: 'Scan', detail: 'grep logs', model: 'claude-sonnet-4-6' },
    { title: 'Verify' },
  ],
})
assert.equal(parsed.scriptBody.startsWith("phase('Scan')"), true)

const compactScript = 'export const meta = { name: "x", description: "y" };\nreturn 1'
assert.equal(parseWorkflowScript(compactScript).scriptBody, 'return 1')

const noSemicolonScript = 'export const meta = { name: "x", description: "y" }\nphase("Body")'
assert.equal(parseWorkflowScript(noSemicolonScript).scriptBody, 'phase("Body")')

for (const [source, pattern] of cases) {
  assert.throws(
    () => parseWorkflowScript(source),
    (error: unknown) => {
      assert.equal(error instanceof WorkflowScriptParseError, true)
      assert.match(String((error as Error).message), pattern)
      return true
    },
  )
}

console.log('workflowScriptParser.test.ts passed')
