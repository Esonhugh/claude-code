import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import ts from 'typescript'

// checkBridgePrerequisites is module-private, so this reads its body.
function prerequisiteStatements(): ts.NodeArray<ts.Statement> {
  const path = new URL('./bridge.tsx', import.meta.url).pathname
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const fn = source.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'checkBridgePrerequisites',
  )
  if (!fn?.body) throw new Error('checkBridgePrerequisites not found')
  return fn.body.statements
}

describe('/remote-control in Code Mode', () => {
  test('checks the Code Mode refusal before any other prerequisite', () => {
    const [first, second] = prerequisiteStatements()
    expect(first!.getText()).toBe('const codeModeRefusal = codeModeRemoteControlRefusal()')
    expect(second!.getText()).toBe('if (codeModeRefusal) return codeModeRefusal')
  })
})
