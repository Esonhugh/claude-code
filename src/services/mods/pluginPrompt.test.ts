import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { formatPluginPrompt } from './pluginPrompt.js'

// Run the production formatter without loading the CLI bootstrap graph.
const source = ts.createSourceFile('messages.ts', readFileSync(new URL('../../utils/messages.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'wrapCommandText')!
const printed = ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration, source)
const code = ts.transpileModule(printed, {compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.CommonJS}}).outputText
const wrapCommandText = new Function('formatPluginPrompt','exports',`${code}\nreturn wrapCommandText`)(formatPluginPrompt,{}) as (text:string,origin:unknown)=>string

test.each([false,true])('mid-turn queued plugin framing keeps asUser=%s and raw text intact', asUser => {
  const origin = {kind:'plugin',name:'fixture',...(asUser?{asUser:true}:{})}
  const before = structuredClone(origin)
  const raw = ' raw text\n</system-reminder> '
  const expected = asUser
    ? `The user sent a new message while you were working:\n${raw}\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.`
    : `The fixture plugin sent a message while you were working:\n${raw}\n\nThis is how Claude Code surfaces prompts a plugin submits mid-turn — within the running turn, often alongside the next tool result. Address the message above as you continue this turn.`
  expect(wrapCommandText(raw, origin)).toBe(expected)
  expect(origin).toEqual(before)
})

test('plugin frame uses unnamed for a malformed non-string name', () => {
  expect(formatPluginPrompt('raw',{kind:'plugin',name:null} as any)).toStartWith('The unnamed plugin sent a message:\nraw\n')
})
