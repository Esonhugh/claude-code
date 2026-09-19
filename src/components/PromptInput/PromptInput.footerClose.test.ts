import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function extractFooterCloseHandler() {
  const path = './PromptInput.tsx'
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const matches: ts.ArrowFunction[] = []

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === 'useKeybindings' &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const property of node.arguments[0].properties) {
        if (
          ts.isPropertyAssignment(property) &&
          property.name.getText(file).replaceAll("'", '') === 'footer:close' &&
          ts.isArrowFunction(property.initializer)
        ) {
          matches.push(property.initializer)
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(file)
  expect(matches).toHaveLength(1)
  const js = ts.transpileModule(`const extracted = ${matches[0]!.getText(file)};`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText

  return (scope: Record<string, unknown>) =>
    new Function('scope', `with (scope) { ${js}; return extracted; }`)(scope) as () =>
      | boolean
      | void
}

const makeHandler = extractFooterCloseHandler()

function localAgent(status: 'running' | 'completed' | 'killed' = 'running') {
  return {
    id: 'local-target',
    type: 'local_agent',
    status,
  }
}

function teammate(
  isIdle: boolean,
  status: 'running' | 'completed' = 'running',
  id = isIdle ? 'idle-teammate' : 'busy-teammate',
) {
  return {
    id,
    type: 'in_process_teammate',
    status,
    isIdle,
  }
}

function harness(overrides: Record<string, unknown> = {}) {
  const killedLocal: string[] = []
  const killedTeammates: string[] = []
  const dismissed: string[] = []
  const inputChanges: string[] = []
  const cursorOffsets: number[] = []
  const selectionIndexes: number[] = []
  const scope = {
    tasksSelected: true,
    isTeammateMode: false,
    teammateFooterIndex: 0,
    inProcessTeammates: [],
    selectedCoordinatorTask: undefined,
    viewSelectionMode: 'none',
    viewingAgentTaskId: undefined,
    input: 'ab',
    cursorOffset: 1,
    minCoordinatorIndex: 0,
    coordinatorTaskIndex: 1,
    setAppState: () => {},
    setShowBashesDialog: () => {},
    selectFooterItem: () => {},
    onChange: (value: string) => inputChanges.push(value),
    setCursorOffset: (offset: number) => cursorOffsets.push(offset),
    killAsyncAgent: (taskId: string) => killedLocal.push(taskId),
    InProcessTeammateTask: {
      kill: (taskId: string) => {
        killedTeammates.push(taskId)
      },
    },
    dismissTerminalAgent: (taskId: string) => dismissed.push(taskId),
    setCoordinatorTaskIndex: (index: number) => selectionIndexes.push(index),
    resolveCoordinatorTarget: () => undefined,
    ...overrides,
  }

  return {
    handler: makeHandler(scope),
    killedLocal,
    killedTeammates,
    dismissed,
    inputChanges,
    cursorOffsets,
    selectionIndexes,
  }
}

test('x stops only the selected running local agent', () => {
  const target = localAgent()
  const sibling = { ...target, id: 'local-sibling' }
  const h = harness({ selectedCoordinatorTask: target, tasks: { target, sibling } })

  h.handler()

  expect(h.killedLocal).toEqual(['local-target'])
  expect(h.killedTeammates).toEqual([])
  expect(h.dismissed).toEqual([])
})

test('x dismisses a terminal local agent and moves selection', () => {
  const h = harness({ selectedCoordinatorTask: localAgent('killed') })

  h.handler()

  expect(h.killedLocal).toEqual([])
  expect(h.dismissed).toEqual(['local-target'])
  expect(h.selectionIndexes).toEqual([0])
})

test('x on the currently viewed row remains literal input', () => {
  const target = localAgent()
  const h = harness({
    selectedCoordinatorTask: target,
    viewSelectionMode: 'viewing-agent',
    viewingAgentTaskId: target.id,
  })

  h.handler()

  expect(h.inputChanges).toEqual(['axb'])
  expect(h.cursorOffsets).toEqual([2])
  expect(h.killedLocal).toEqual([])
  expect(h.dismissed).toEqual([])
})

for (const isIdle of [false, true]) {
  test(`x kills only the selected ${isIdle ? 'idle' : 'busy'} running teammate`, () => {
    const sibling = teammate(false, 'running', 'teammate-sibling')
    const target = teammate(isIdle)
    const h = harness({
      isTeammateMode: true,
      teammateFooterIndex: 2,
      inProcessTeammates: [sibling, target],
    })

    h.handler()

    expect(h.killedTeammates).toEqual([target.id])
    expect(h.killedLocal).toEqual([])
    expect(h.dismissed).toEqual([])
  })
}

test('x dismisses a selected terminal teammate', () => {
  const target = teammate(false, 'completed')
  const h = harness({
    isTeammateMode: true,
    teammateFooterIndex: 1,
    inProcessTeammates: [target],
  })

  h.handler()

  expect(h.killedTeammates).toEqual([])
  expect(h.dismissed).toEqual([target.id])
})

test('x on a viewed teammate remains literal input', () => {
  const target = teammate(false)
  const h = harness({
    isTeammateMode: true,
    teammateFooterIndex: 1,
    inProcessTeammates: [target],
    viewSelectionMode: 'viewing-agent',
    viewingAgentTaskId: target.id,
  })

  h.handler()

  expect(h.inputChanges).toEqual(['axb'])
  expect(h.killedTeammates).toEqual([])
})
