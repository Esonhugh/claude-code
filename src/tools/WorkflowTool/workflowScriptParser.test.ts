import assert from 'node:assert/strict'

import {
  parseWorkflowScript,
  WorkflowScriptParseError,
} from './workflowScriptParser.js'

function assertParseError(source: string, pattern: RegExp): void {
  assert.throws(
    () => parseWorkflowScript(source),
    (error: unknown) => {
      assert.equal(error instanceof WorkflowScriptParseError, true)
      assert.match(String((error as Error).message), pattern)
      return true
    },
  )
}

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

const whitespaceBodyScript = 'export const meta = { name: "x", description: "y" }\n\n  phase("Body")'
assert.equal(parseWorkflowScript(whitespaceBodyScript).scriptBody, 'phase("Body")')

const topLevelSyntaxScript = `export const meta = { name: 'x', description: 'y' }
await agent('ok')
return 1
`
assert.equal(parseWorkflowScript(topLevelSyntaxScript).scriptBody, "await agent('ok')\nreturn 1\n")

assertParseError('import x from "x"\nexport const meta = { name: "x", description: "y" }', /FIRST statement/)
assertParseError('const x = 1\nexport const meta = { name: "x", description: "y" }', /FIRST statement/)
assertParseError('export { meta }', /FIRST statement/)
assertParseError('export let meta = { name: "x", description: "y" }', /FIRST statement/)
assertParseError('export const meta = makeMeta()', /FIRST statement/)
assertParseError('export const meta: any = { name: "x", description: "y" }', /plain JavaScript/)
assertParseError('export const meta = { name: "", description: "y" }', /meta\.name/)
assertParseError('export const meta = { name: "x", description: "" }', /meta\.description/)
assertParseError('export const meta = { name: "x", description: "y", value: compute() }', /pure literal/)
assertParseError('export const meta = { name: "x", description: "y", ...extra }', /pure literal/)
assertParseError('export const meta = { name: `x ${value}`, description: "y" }', /pure literal/)
assertParseError('export const meta = { ["name"]: "x", description: "y" }', /pure literal/)
assertParseError('export const meta = { name: "x", description: "y", value: +1 }', /pure literal/)
assertParseError('export const meta = { name: "x", description: "y", values: [1,,2] }', /pure literal/)
assertParseError('export const meta = { name: "x", description: "y", get value() { return 1 } }', /pure literal/)
assertParseError('export const meta = { name: "x", description: "y", value() { return 1 } }', /pure literal/)
assertParseError('export const meta = { name: "x", description: "y", __proto__: {} }', /reserved key/)
assertParseError('export const meta = { name: "x", description: "y", constructor: {} }', /reserved key/)
assertParseError('export const meta = { name: "x", description: "y", prototype: {} }', /reserved key/)

const literalScript = `export const meta = {
  name: ` + '`literal-name`' + `,
  description: 'literal description',
  value: -1,
}
return 1
`
assert.equal(parseWorkflowScript(literalScript).meta.name, 'literal-name')

const looseMeta = parseWorkflowScript(`export const meta = {
  name: 'loose',
  description: 'Loose official metadata normalization',
  title: '',
  whenToUse: '',
  phases: [
    null,
    { title: 123, detail: 'bad title' },
    { detail: 'missing title' },
    { title: 'Good', detail: 42, model: false },
    { title: 'Also Good', detail: 'details', model: 'claude-sonnet-4-6' },
  ],
}
return 'ok'
`)
assert.deepEqual(looseMeta.meta, {
  name: 'loose',
  description: 'Loose official metadata normalization',
  whenToUse: '',
  phases: [
    { title: 'Good' },
    { title: 'Also Good', detail: 'details', model: 'claude-sonnet-4-6' },
  ],
})

const nonArrayPhases = parseWorkflowScript(`export const meta = {
  name: 'no-phases',
  description: 'Non-array phases are ignored',
  phases: 'not an array',
}
return 'ok'
`)
assert.deepEqual(nonArrayPhases.meta, {
  name: 'no-phases',
  description: 'Non-array phases are ignored',
})

console.log('workflowScriptParser.test.ts passed')
