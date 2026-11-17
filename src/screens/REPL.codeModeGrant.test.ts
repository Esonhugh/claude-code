import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
// toolWrappers first: it settles the AgentTool import cycle the way the app does.
import '../tools/REPLTool/toolWrappers.js'
import { primitiveToolGrant } from '../tools/AgentTool/agentToolUtils.js'

// The main-thread ToolUseContext sets primitiveToolGrant inline; evaluate that initializer.
function mainThreadGrant(): (scope: Record<string, unknown>) => ReadonlySet<string> | undefined {
  const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('REPL.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const matches: ts.Expression[] = []
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'primitiveToolGrant') matches.push(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(matches).toHaveLength(1)
  const js = ts.transpileModule(`return (${matches[0]!.getText(file)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return scope => new Function('scope', `with (scope) { ${js} }`)(scope)
}

const grant = mainThreadGrant()
const agent = { agentType: 'reviewer', tools: ['Read', 'Grep'], source: 'userSettings', whenToUse: '', getSystemPrompt: () => '' }

test('an --agent main thread limits REPL scripts to its tools in Code Mode', () => {
  const result = grant({ mainThreadAgentDefinition: agent, isCodeModeEnabled: () => true, primitiveToolGrant })
  expect([...result!].sort()).toEqual(['Grep', 'Read'])
})

test('no grant without an agent or with Code Mode off', () => {
  expect(grant({ mainThreadAgentDefinition: undefined, isCodeModeEnabled: () => true, primitiveToolGrant })).toBeUndefined()
  expect(grant({ mainThreadAgentDefinition: agent, isCodeModeEnabled: () => false, primitiveToolGrant })).toBeUndefined()
})
