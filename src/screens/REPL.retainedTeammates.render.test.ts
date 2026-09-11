import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import * as React from 'react'
import ts from 'typescript'
import { Box, Text, render } from '../ink.js'

process.env.NODE_ENV = 'test'

const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')
const file = ts.createSourceFile('REPL.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const fragments: ts.JsxFragment[] = []
function visit(node: ts.Node): void {
  if (ts.isJsxAttribute(node) && node.name.getText(file) === 'scrollable' &&
    node.initializer && ts.isJsxExpression(node.initializer) &&
    node.initializer.expression && ts.isJsxFragment(node.initializer.expression) &&
    node.initializer.expression.getText(file).includes('<LocalAgentSpinner')) {
    fragments.push(node.initializer.expression)
  }
  ts.forEachChild(node, visit)
}
visit(file)
expect(fragments).toHaveLength(1)
const children = fragments[0]!.children
const start = children.findIndex(node => ts.isJsxExpression(node) && node.getText(file).includes('<LocalAgentSpinner'))
expect(start).toBeGreaterThanOrEqual(0)
const jsx = `<>${children.slice(start).map(node => node.getText(file)).join('\n')}</>`
const js = ts.transpileModule(`const element = (${jsx});`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const evaluate = new Function('scope', `with (scope) { ${js}; return element; }`) as
  (scope: Record<string, unknown>) => React.ReactNode

async function renderBranch(bindings: Record<string, unknown> = {}) {
  let treeMounts = 0
  let spinnerMounts = 0
  const element = evaluate({
    React, Box,
    viewedAgentTask: undefined,
    isLocalAgentTask: () => false,
    showSpinner: false,
    isLoading: false,
    userInputOnProcessing: false,
    hasRunningTeammates: false,
    isBriefOnly: false,
    isFullscreenEnvEnabled: () => false,
    showTeammateTree: true,
    selectedIPAgentIndex: -1,
    viewSelectionMode: 'selecting-agent',
    toolJSX: undefined,
    toolUseConfirmQueue: [],
    promptQueue: [],
    pendingWorkerRequest: undefined,
    onlySleepToolActive: false,
    visibleStreamingText: undefined,
    SpinnerWithVerb: () => {
      spinnerMounts++
      return React.createElement(Text, null, 'ACTIVE_SPINNER')
    },
    LocalAgentSpinner: () => React.createElement(Text, null, 'LOCAL_SPINNER'),
    BriefIdleStatus: () => React.createElement(Text, null, 'BRIEF_IDLE'),
    TeammateSpinnerTree: () => {
      treeMounts++
      return React.createElement(Text, null, 'RETAINED_TREE')
    },
    ...bindings,
  })
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: false, setRawMode() {} })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  const app = await render(React.createElement(Box, null, element), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false, patchConsole: false,
  })
  try {
    expect(output).not.toContain('ERROR')
    return { output, treeMounts, spinnerMounts }
  } finally {
    app.unmount()
    app.cleanup()
  }
}

test('REPL mounts expanded teammate navigation while main is idle without starting a spinner', async () => {
  const result = await renderBranch()
  expect(result.spinnerMounts).toBe(0)
  expect(result.treeMounts).toBeGreaterThan(0)
  expect(result.output).toContain('RETAINED_TREE')
})

test('REPL does not mount idle navigation when collapsed or blocked by another UI', async () => {
  for (const bindings of [
    { showTeammateTree: false },
    { toolJSX: { showSpinner: false } },
    { toolUseConfirmQueue: [{}] },
    { promptQueue: [{}] },
    { pendingWorkerRequest: {} },
    { onlySleepToolActive: true },
    { visibleStreamingText: 'streaming' },
    { viewedAgentTask: {}, isLocalAgentTask: () => true, viewedAgentToolUseIDs: new Set(), verbose: false },
  ]) {
    const result = await renderBranch(bindings)
    expect(result.treeMounts).toBe(0)
    expect(result.spinnerMounts).toBe(0)
  }
})
