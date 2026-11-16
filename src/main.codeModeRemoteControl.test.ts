import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import ts from 'typescript'

// main.tsx cannot be imported under bun (see main.signals.test.ts), so this
// reads the two startup expressions that decide Code Mode and the bridge.
const path = new URL('./main.tsx', import.meta.url).pathname
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function find<T extends ts.Node>(match: (node: ts.Node) => node is T): T[] {
  const found: T[] = []
  const visit = (node: ts.Node): void => {
    if (match(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function settleAsk(): string {
  const [call] = find(
    (n): n is ts.CallExpression =>
      ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'settleCodeModeGate',
  )
  const arg = call?.arguments[0]
  if (!arg || !ts.isObjectLiteralExpression(arg)) throw new Error('settleCodeModeGate call not found')
  const prop = arg.properties.find(
    (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'remoteControl',
  )
  if (!prop) throw new Error('remoteControl ask not found')
  return prop.initializer.getText()
}

function fullRemoteControl(): string {
  const [decl] = find(
    (n): n is ts.VariableDeclaration =>
      ts.isVariableDeclaration(n) && n.name.getText() === 'fullRemoteControl',
  )
  if (!decl?.initializer) throw new Error('fullRemoteControl not found')
  return decl.initializer.getText()
}

describe('Remote Control at startup in Code Mode (official 2.1.325)', () => {
  test('only --rc and an assistant session are the Code Mode ask', () => {
    expect(settleAsk()).toBe('remoteControlOption !== undefined || kairosEnabled')
  })

  test('the remoteControlAtStartup default still starts the bridge, which initReplBridge refuses', () => {
    expect(fullRemoteControl()).toContain('getRemoteControlAtStartup()')
  })
})
