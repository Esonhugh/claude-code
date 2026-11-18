import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import ts from 'typescript'

// Every onStateChange('failed', …) in the bridge cores, with the kind it
// carries. Unclassified ones resolve to terminal (or auth right after an auth
// revive) in useReplBridge, as in official 2.1.325.
function failedEmitters(file: string): [string, string | undefined][] {
  const path = new URL(file, import.meta.url).pathname
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: [string, string | undefined][] = []
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText().replace(/\?\.$/, '').endsWith('onStateChange') &&
      node.arguments[0]?.getText() === "'failed'"
    ) {
      const kind = node.arguments[2]
      found.push([node.arguments[1]!.getText(), kind && ts.isStringLiteral(kind) ? kind.text : kind?.getText()])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('Remote Control failure kinds per emitter', () => {
  test('env-less (v2) core', () => {
    expect(failedEmitters('./remoteBridgeCore.ts')).toEqual([
      ["'Session creation failed — see debug log'", undefined],
      ["'Remote credentials fetch failed — see debug log'", 'terminal'],
      ['`Transport setup failed: ${errorMessage(err)}`', undefined],
      ['`Refresh failed: ${errorMessage(err)}`', 'terminal'],
      ['`Transport closed: ${describeCloseCode(code)}`', 'terminal'],
      ["'JWT refresh failed: no OAuth token — run /login'", 'auth'],
      ["'OAuth token refresh failed — run /login to re-authenticate'", 'auth'],
      ['`JWT refresh failed: ${errorMessage(err)}`', 'terminal'],
    ])
  })

  test('init preconditions', () => {
    expect(failedEmitters('./initReplBridge.ts')).toEqual([
      ['codeModeRefusal', undefined],
      ["'/login'", 'auth'],
      ['"disabled by your organization\'s policy"', undefined],
      ["'/login'", 'auth'],
      ["'/login'", 'auth'],
      ["'run `claude update` to upgrade'", 'terminal'],
      ["'run `claude update` to upgrade'", 'terminal'],
    ])
  })

  test('env-based (v1) core: a server-side close is "ended elsewhere", the rest terminal', () => {
    const emitters = failedEmitters('./replBridge.ts')
    expect(emitters).toContainEqual(["'session ended'", 'ended_elsewhere'])
    expect(emitters.filter(([, kind]) => kind !== 'terminal' && kind !== 'ended_elsewhere')).toEqual([])
    expect(emitters.length).toBeGreaterThanOrEqual(8)
  })
})
