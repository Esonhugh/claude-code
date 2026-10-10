import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { ProgramStatus } from '../ink/termio/osc.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'

// Exercise the actual REPL selector without importing its startup/services graph.
const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')
const file = ts.createSourceFile(
  'REPL.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
)
const declarations: string[] = []
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(file) === 'terminalProgramStatus'
  ) {
    declarations.push(`const ${node.getText(file)};`)
  }
  ts.forEachChild(node, visit)
}
visit(file)
const js = ts.transpileModule(declarations.join('\n'), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  },
}).outputText
const evaluate = new Function(
  'scope',
  `with (scope) { ${js}; return terminalProgramStatus; }`,
) as (scope: Record<string, unknown>) => ProgramStatus
function status(bindings: Record<string, unknown> = {}): ProgramStatus {
  expect(declarations).toHaveLength(1)
  return evaluate({
    ASK_USER_QUESTION_TOOL_NAME,
    toolUseConfirmQueue: [],
    promptQueue: [],
    sandboxPermissionRequestQueue: [],
    workerSandboxPermissions: { queue: [] },
    elicitation: { queue: [] },
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    isShowingLocalJSXCommand: false,
    isLoading: false,
    ...bindings,
  })
}

test('REPL reports idle at prompt/completion/cancellation and working while loading', () => {
  expect(status()).toEqual({ state: 'idle' })
  expect(status({ isLoading: true })).toEqual({ state: 'working' })
  expect(status({ isLoading: false })).toEqual({ state: 'idle' })
})

test('all local and worker permission queues override working', () => {
  for (const bindings of [
    { toolUseConfirmQueue: [{ tool: { name: 'Bash' } }] },
    { sandboxPermissionRequestQueue: [{}] },
    { workerSandboxPermissions: { queue: [{}] } },
    { pendingWorkerRequest: { toolName: 'Bash' } },
    { pendingSandboxRequest: {} },
  ]) {
    expect(status({ ...bindings, isLoading: true })).toEqual({
      state: 'blocked',
      kind: 'permission',
    })
    expect(status(bindings)).toEqual({ state: 'blocked', kind: 'permission' })
  }
})

test('questions and dialogs report question rather than permission', () => {
  for (const bindings of [
    { toolUseConfirmQueue: [{ tool: { name: ASK_USER_QUESTION_TOOL_NAME } }] },
    { pendingWorkerRequest: { toolName: ASK_USER_QUESTION_TOOL_NAME } },
    { promptQueue: [{}] },
    { elicitation: { queue: [{}] } },
    { isShowingLocalJSXCommand: true },
  ]) {
    expect(status({ ...bindings, isLoading: true })).toEqual({
      state: 'blocked',
      kind: 'question',
    })
  }
})

test('sandbox and foreground tool permissions take precedence over question queues', () => {
  expect(
    status({
      toolUseConfirmQueue: [{ tool: { name: 'Bash' } }],
      promptQueue: [{}],
    }),
  ).toEqual({ state: 'blocked', kind: 'permission' })
  expect(
    status({
      sandboxPermissionRequestQueue: [{}],
      toolUseConfirmQueue: [{ tool: { name: ASK_USER_QUESTION_TOOL_NAME } }],
    }),
  ).toEqual({ state: 'blocked', kind: 'permission' })
})
