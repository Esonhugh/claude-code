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
      modsSession: undefined,
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

test('only a Stop input notifies Mods, not editing history or confirming rewind', async () => {
  const declaration = (name: string) => find((n): n is ts.VariableDeclaration =>
    ts.isVariableDeclaration(n) && n.name.getText(file) === name)[0]!.initializer as ts.ObjectLiteralExpression
  const property = (object: ts.ObjectLiteralExpression, name: string) => {
    const p = object.properties.find(p => p.name?.getText(file) === name)!
    return ts.isPropertyAssignment(p) ? p.initializer.getText(file) : name
  }
  const restore = find((n): n is ts.JsxAttribute => ts.isJsxAttribute(n) && n.name.getText(file) === 'onPreRestore')[0]!
  const cancel = find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'onCancel')[0]!
  const events: boolean[] = []
  const scope = { focusedInputDialog: null, streamMode: null, isLoading: true, feature: () => false,
    modsSession: {runtime:{notifySessionStop:(busy:boolean) => events.push(busy)}}, logForDebugging: () => {},
    queryGuard: { isActive: false, forceEnd() { throw cancelled } },
    messages: [{uuid:'id'}], findRawIndex: () => 0, selectableUserMessagesFilter: () => true,
    fileHistory: {}, fileHistoryHasAnyChanges: async () => false, messagesAfterAreOnlySynthetic: () => true,
  }
  const cancelled = new Error('reached turn cancellation')
  const invoke = async (expr: string) => {
    const js = ts.transpileModule(`${cancel.getText(file)}; return (${expr})({uuid:'id'})`, {
      compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},
    }).outputText
    await expect(async () => new Function('scope', `with(scope){${js}}`)(scope)).toThrow(cancelled)
  }
  await invoke(property(declaration('messageActionCaps'), 'edit'))
  await invoke((restore.initializer as ts.JsxExpression).expression!.getText(file))
  expect(events).toEqual([])
  await invoke(property(declaration('cancelRequestProps'), 'onCancel'))
  expect(events).toEqual([true])
})

test('the handler is mounted beside CancelRequestHandler, only between turns, in the capture phase', () => {
  const elements = find((node): node is ts.JsxSelfClosingElement =>
    ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'ReplEvalCancelHandler')
  expect(elements).toHaveLength(1)
  expect(elements[0]!.attributes.getText(file)).toContain('!isLoading')
  expect(elements[0]!.attributes.getText(file)).toContain('!inputValue')
  const bindings = find((node): node is ts.CallExpression =>
    ts.isCallExpression(node) && node.expression.getText(file) === 'useKeybinding' &&
    node.arguments[1]?.getText(file) === 'stopDispatchedReplEvals')
  expect(bindings.map(b => b.arguments[0]!.getText(file))).toEqual(["'chat:cancel'", "'app:interrupt'"])
  for (const binding of bindings) expect(binding.arguments[2]!.getText(file)).toContain('capture: true')
  // Ctrl+C is Global: it must run before the double-press exit and PromptInput's own interrupt.
  expect(bindings[1]!.arguments[2]!.getText(file)).toContain("context: 'Global'")
})

// Official 329: Ctrl+C at an empty prompt with stoppable scripts ("stop-background-work") raises
// session.stop { isTurnRunning: false } and then interrupts them, without waiting on the hooks.
test('stopping scripts raises session.stop before the abort and does not wait on it', () => {
  const s = scope(1)
  const order: string[] = []
  const values = {
    ...s.values,
    abortPendingReplEvals: () => order.push('abort'),
    modsSession: { runtime: { notifySessionStop: (busy: boolean) => (order.push(`stop:${busy}`), new Promise(() => {})) } },
  }
  expect(escHandler()(values)).toBeUndefined()
  expect(order).toEqual(['stop:false', 'abort'])
})
