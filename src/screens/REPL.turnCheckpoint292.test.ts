import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { count } from '../utils/array.js'
import { createAssistantMessage, createUserMessage, createTurnDurationMessage, normalizeMessagesForAPI } from '../utils/messages.js'
import { isLoggableMessage } from '../utils/sessionStorage.js'
import { projectModSessionMessages } from '../services/mods/sessionMessages.js'
import type { Message } from '../types/message.js'

// Execute the production turn-end statements, without importing the REPL startup graph.
const text = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')
const file = ts.createSourceFile('REPL.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const matches: ts.VariableDeclaration[] = []
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'turnDurationMs') matches.push(node)
  ts.forEachChild(node, visit)
}
visit(file)
if (matches.length !== 1) throw new Error('Expected the unique REPL turn-end duration declaration')
const statement = matches[0]!.parent.parent
if (!ts.isVariableStatement(statement) || !ts.isBlock(statement.parent)) throw new Error('Duration declaration must live in the turn-end block')
const index = statement.parent.statements.indexOf(statement)
const guard = statement.parent.statements[index + 1]
if (!guard || !ts.isIfStatement(guard)) throw new Error('Expected the turn checkpoint guard immediately after its duration calculation')
const js = ts.transpileModule(statement.getText(file) + '\n' + guard.getText(file), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const checkpoint = new Function('scope', `with (scope) { ${js} }`)

function run(options: { durationMs: number; didQuery?: boolean; aborted?: boolean; proactive?: boolean; budget?: { tokens: number; limit: number; nudges: number }; swarmRunning?: boolean; deferredStart?: number }) {
  const initial: Message[] = [createUserMessage({ content: 'request' }), createAssistantMessage({ content: 'reply' })]
  const messages = [...initial]
  const swarmStartTimeRef: { current: number | null } = { current: options.deferredStart ?? null }
  const swarmBudgetInfoRef: { current: typeof options.budget } = { current: undefined }
  checkpoint({
    Date: { now: () => 100_000 },
    loadingStartTimeRef: { current: 100_000 - options.durationMs }, totalPausedMsRef: { current: 0 },
    abortController: { signal: { aborted: options.aborted ?? false } },
    didQuery: options.didQuery ?? true, proactiveActive: options.proactive ?? false, budgetInfo: options.budget,
    getAllInProcessTeammateTasks: () => options.swarmRunning ? [{ status: 'running' }] : [],
    store: { getState: () => ({ tasks: {} }) }, swarmStartTimeRef, swarmBudgetInfoRef,
    count, isLoggableMessage, createTurnDurationMessage, logForDebugging: () => {},
    setMessages: (update: (previous: Message[]) => Message[]) => { messages.splice(0, messages.length, ...update(messages)) },
  })
  return { initial, messages, swarmStartTimeRef, swarmBudgetInfoRef }
}

// Source baseline: official 2.1.292 run finally records every completed main turn.
// Duration is a transcript checkpoint even when UI has showTurnDuration=false.
test.each([0, 1, 29_999, 30_000, 30_001])('292 records a completed main turn of %d ms', durationMs => {
  const { messages } = run({ durationMs })
  expect(messages).toHaveLength(3)
  expect(messages[2]).toMatchObject({ type: 'system', subtype: 'turn_duration', durationMs, messageCount: 2, isMeta: false })
  expect(isLoggableMessage(messages[2]!)).toBe(true)
})

test('292 short budget turns retain the checkpoint budget fields', () => {
  const { messages } = run({ durationMs: 1, budget: { tokens: 4, limit: 3, nudges: 1 } })
  expect(messages[2]).toMatchObject({ budgetTokens: 4, budgetLimit: 3, budgetNudges: 1 })
})

test.each([undefined, { tokens: 4, limit: 3, nudges: 1 }])('292 canceled turns do not append a checkpoint (budget=%p)', budget => {
  expect(run({ durationMs: 45_000, aborted: true, budget }).messages).toHaveLength(2)
})

test.each([undefined, { tokens: 4, limit: 3, nudges: 1 }])('automatic loop turns keep the existing no-checkpoint rule (budget=%p)', budget => {
  expect(run({ durationMs: 45_000, proactive: true, budget }).messages).toHaveLength(2)
})

test('292 short turns defer the checkpoint while swarm teammates are running', () => {
  const result = run({ durationMs: 1, swarmRunning: true })
  expect(result.messages).toHaveLength(2)
  expect(result.swarmStartTimeRef.current).toBe(99_999)
})

test('292 later swarm turns preserve the original start and update the budget', () => {
  const budget = { tokens: 4, limit: 3, nudges: 1 }
  const result = run({ durationMs: 1, swarmRunning: true, deferredStart: 90_000, budget })
  expect(result.messages).toHaveLength(2)
  expect(result.swarmStartTimeRef.current).toBe(90_000)
  expect(result.swarmBudgetInfoRef.current).toEqual(budget)
})

test('292 checkpoints increase raw history without becoming API or public session chat rows', () => {
  const { initial, messages } = run({ durationMs: 1 })
  expect(messages).toHaveLength(initial.length + 1)
  expect(normalizeMessagesForAPI(messages, [])).toEqual(normalizeMessagesForAPI(initial, []))
  expect(projectModSessionMessages(messages)).toEqual(projectModSessionMessages(initial))
})

// A local command or a refusal before onQueryImpl must not add a model checkpoint.
test.each([undefined, { tokens: 4, limit: 3, nudges: 1 }])('non-query commands and preflight refusals do not record a turn (budget=%p)', budget => {
  expect(run({ durationMs: 1, didQuery: false, budget }).messages).toHaveLength(2)
})

const onQueryDeclarations: ts.VariableDeclaration[] = []
function findOnQuery(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'onQuery') onQueryDeclarations.push(node)
  ts.forEachChild(node, findOnQuery)
}
findOnQuery(file)
if (onQueryDeclarations.length !== 1) throw new Error('Expected unique onQuery callback')
const call = onQueryDeclarations[0]!.initializer
if (!call || !ts.isCallExpression(call)) throw new Error('Expected onQuery useCallback')
const callback = call.arguments[0]
if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body)) throw new Error('Expected onQuery callback body')
const runBlock = callback.body.statements.find(ts.isTryStatement)
const didQuery = callback.body.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(file) === 'didQuery'))
if (!runBlock || !didQuery) throw new Error('Expected actual-query admission guard')
const admittedJS = ts.transpileModule(`${didQuery.getText(file)}; try ${runBlock.tryBlock.getText(file)} finally { ${statement.getText(file)}; ${guard.getText(file)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const admittedCheckpoint = new Function('scope', `with (scope) { return (async () => { ${admittedJS} })() }`)

test.each([
  { shouldQuery: false, proceed: true },
  { shouldQuery: true, proceed: false },
  { shouldQuery: false, proceed: false },
  { shouldQuery: true, proceed: true },
])('actual query admission records only a proceeded model turn (%p)', async ({ shouldQuery, proceed }) => {
  const messages: Message[] = [createUserMessage({ content: 'request' }), createAssistantMessage({ content: 'reply' })]
  let calls = 0
  const logs: string[] = []
  await admittedCheckpoint({
    Date: { now: () => 100_000 }, loadingStartTimeRef: { current: 99_999 }, totalPausedMsRef: { current: 0 },
    abortController: { signal: { aborted: false } }, proactiveActive: false, budgetInfo: undefined,
    getAllInProcessTeammateTasks: () => [], store: { getState: () => ({ tasks: {} }) },
    swarmStartTimeRef: { current: null }, swarmBudgetInfoRef: { current: undefined },
    count, isLoggableMessage, createTurnDurationMessage, logForDebugging: (value: string) => logs.push(value),
    resetTimingRefs: () => {}, newMessages: [], responseLengthRef: { current: 0 }, feature: () => false,
    apiMetricsRef: { current: [] }, setStreamingToolUses: () => {}, setStreamingText: () => {},
    messagesRef: { current: messages }, input: 'request', mrOnBeforeQuery: async () => {},
    onBeforeQueryCallback: async () => proceed, onQueryImpl: async () => { calls++ },
    shouldQuery, additionalAllowedTools: [], mainLoopModelParam: 'model', effort: undefined, publicTurn: undefined,
    setMessages: (update: (previous: Message[]) => Message[]) => { messages.splice(0, messages.length, ...update(messages)) },
  })
  expect(calls).toBe(proceed ? 1 : 0)
  expect(messages).toHaveLength(shouldQuery && proceed ? 3 : 2)
  expect(logs).toEqual(shouldQuery && proceed ? ['[turn-duration] completed elapsedMs=1'] : [])
})
