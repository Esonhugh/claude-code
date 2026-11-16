import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')
const file = ts.createSourceFile('REPL.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function find<T extends ts.Node>(test: (node: ts.Node) => node is T): T[] {
  const found: T[] = []
  const visit = (node: ts.Node) => {
    if (test(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

// The Esc callback in ReplEvalCancelHandler, evaluated against a stub scope.
function escHandler(): (scope: Record<string, unknown>) => unknown {
  const decls = find((node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) && node.name.getText(file) === 'stopDispatchedReplEvals')
  expect(decls).toHaveLength(1)
  const call = decls[0]!.initializer as ts.CallExpression
  const js = ts.transpileModule(`return (${call.arguments[0]!.getText(file)})();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return scope => new Function('scope', `with (scope) { ${js} }`)(scope)
}

function scope(pending: number) {
  const aborted: unknown[] = []
  const session = { pending: new Map(Array.from({ length: pending }, (_, i) => [i + 1, {}])) }
  return {
    aborted,
    values: {
      MAIN_REPL_SESSION: 'main',
      findReplSession: (key: string) => (key === 'main' ? session : undefined),
      abortPendingReplEvals: (s: unknown, reason: unknown) => aborted.push([s, reason]),
      logEvent: () => {},
    },
  }
}

test('Esc between turns stops the main thread\'s dispatched REPL scripts', () => {
  const s = scope(2)
  expect(escHandler()(s.values)).toBeUndefined()
  expect(s.aborted).toHaveLength(1)
  // Official stops a running eval with the reason "user-cancel" (`kge.abort`, `ReplSessions.interrupt`).
  expect((s.aborted[0] as unknown[])[1]).toBe('user-cancel')
})

test('with nothing dispatched Esc falls through to the prompt', () => {
  const s = scope(0)
  expect(escHandler()(s.values)).toBe(false)
  expect(escHandler()({ ...s.values, findReplSession: () => undefined })).toBe(false)
  expect(s.aborted).toHaveLength(0)
})

test('the handler is mounted beside CancelRequestHandler, only between turns, in the capture phase', () => {
  const elements = find((node): node is ts.JsxSelfClosingElement =>
    ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'ReplEvalCancelHandler')
  expect(elements).toHaveLength(1)
  expect(elements[0]!.attributes.getText(file)).toContain('!isLoading')
  expect(elements[0]!.attributes.getText(file)).toContain('!inputValue')
  const binding = find((node): node is ts.CallExpression =>
    ts.isCallExpression(node) && node.expression.getText(file) === 'useKeybinding' &&
    node.arguments[1]?.getText(file) === 'stopDispatchedReplEvals')
  expect(binding).toHaveLength(1)
  expect(binding[0]!.arguments[2]!.getText(file)).toContain('capture: true')
})
