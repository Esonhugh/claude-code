import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')
const file = ts.createSourceFile('REPL.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
}

function collect(node: ts.Node, found: (n: ts.Node) => boolean, out: ts.Node[]): ts.Node[] {
  if (found(node)) out.push(node)
  ts.forEachChild(node, child => {
    if (!isFunctionLike(child)) collect(child, found, out)
  })
  return out
}

const isHookCall = (n: ts.Node) =>
  ts.isCallExpression(n) && /^(React\.)?use[A-Z]/.test(n.expression.getText(file))

// Ctrl+O switches to the transcript screen, which returns early from REPL;
// a hook placed after that return makes React throw "Rendered fewer hooks".
test('REPL calls no hook after an early return', () => {
  let repl: ts.FunctionDeclaration | undefined
  ts.forEachChild(file, node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'REPL') repl = node
  })
  expect(repl?.body).toBeDefined()
  let earlyReturnLine: number | undefined
  const late: string[] = []
  for (const statement of repl!.body!.statements) {
    if (earlyReturnLine !== undefined) {
      for (const call of collect(statement, isHookCall, []))
        late.push(`${(call as ts.CallExpression).expression.getText(file)} at line ${file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1}`)
    }
    if (ts.isIfStatement(statement) && collect(statement, ts.isReturnStatement, []).length > 0)
      earlyReturnLine ??= file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1
  }
  expect(earlyReturnLine).toBeDefined()
  expect(late).toEqual([])
})
