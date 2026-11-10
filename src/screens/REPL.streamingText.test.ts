import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Execute the production onStreamingText callback without importing the REPL startup graph.
const text = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')
const file = ts.createSourceFile('REPL.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let callback: ts.Node | undefined
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'onStreamingText') {
    const init = node.initializer
    if (init && ts.isCallExpression(init)) callback = init.arguments[0]
  }
  ts.forEachChild(node, visit)
}
visit(file)
if (!callback) throw new Error('Expected REPL onStreamingText useCallback')
const js = ts.transpileModule(`return (${callback.getText(file)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

function setup() {
  const streamingTextRef = { current: null as string | null }
  const states: Array<string | null> = []
  const onStreamingText = new Function('scope', `with (scope) { ${js} }`)({
    streamingTextRef,
    setStreamingLines: (value: string | null) => states.push(value),
  }) as (f: (current: string | null) => string | null) => void
  const append = (delta: string) => onStreamingText(current => (current ?? '') + delta)
  return { streamingTextRef, states, append, clear: () => onStreamingText(() => null) }
}

test('streaming state only holds complete lines while the ref keeps the full text', () => {
  const { streamingTextRef, states, append, clear } = setup()
  append('Hello ')
  append('world')
  expect(states.at(-1)).toBeNull()
  append('\nnext ')
  expect(states.at(-1)).toBe('Hello world\n')
  append('line')
  // Same visible value, so React bails out instead of re-rendering REPL per delta.
  expect(states.at(-1)).toBe('Hello world\n')
  expect(streamingTextRef.current).toBe('Hello world\nnext line')
  clear()
  expect(states.at(-1)).toBeNull()
  expect(streamingTextRef.current).toBeNull()
})

test('Esc keeps the full partial text, including the unfinished line', () => {
  const start = text.indexOf('function onCancel()')
  const body = text.slice(start, text.indexOf('resetLoadingState()', start))
  expect(body).toContain('const partialText = streamingTextRef.current')
  expect(body).toContain('createAssistantMessage({ content: partialText })')
})
