import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import officialDeclaration from '../../../assets/mods-2.1.303.d.ts.txt' with {type:'text'}
import { OFFICIAL_CORE_CALLS } from './coreCalls.js'
import { loadModDeclaration } from './loader.js'
import { createModsRuntime } from './runtime.js'

const source = ts.createSourceFile('mods.d.ts', officialDeclaration, ts.ScriptTarget.Latest, true)
let core: ts.InterfaceDeclaration | undefined
function findCore(node: ts.Node) {
  if (ts.isInterfaceDeclaration(node) && node.name.text === 'CoreEngineInterface') core = node
  ts.forEachChild(node, findCore)
}
findCore(source)
if (!core) throw new Error('Official CoreEngineInterface missing')
const declared = core.members.flatMap(noun => {
  if (!ts.isPropertySignature(noun) || !noun.type || !ts.isTypeLiteralNode(noun.type) || noun.name.getText(source) === 'plugin') return []
  // Aliases with overloaded signatures are calls too (e.g. command.run, fs.read).
  return noun.type.members.map(method => `${noun.name.getText(source)}.${method.name!.getText(source)}`)
}).sort()

test('public core call inventory covers every official method, including overloads', () => {
  expect(declared).toEqual([...OFFICIAL_CORE_CALLS].sort())
})

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']
let saved: (string | undefined)[]
beforeEach(async () => {
  saved = keys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-core-contract-')))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.ANTHROPIC_API_KEY = 'sk-core-contract-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
})
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  await rm(root, {recursive:true,force:true})
})

// Exercise bad arguments where effects could otherwise write, launch, or query.
// The contract concerns admission and host errors, not an invented success value.
function argumentsFor(op: string): string {
  if (op.startsWith('env.')) return '"CORE_CONTRACT_VALUE"'
  if (op.startsWith('state.')) return '{plugin:"example",key:"value"}'
  if (['clock.now','session.cwd','session.root','session.model','session.turns','session.id','session.repo','session.surfaces','session.surface','session.version','ui.panes','prompt.read','command.list','config.list','agent.list','store.keys','tool.list'].includes(op)) return ''
  return '{}'
}

test.each([...OFFICIAL_CORE_CALLS])('official %s loads and reaches a catchable host call', async op => {
  const path = join(root, 'register.mjs')
  await writeFile(path, `export function register(on) {
    on('tool.call', async $ => {
      try { await $.${op}(${argumentsFor(op)}); return {result:{returned:true}} }
      catch(error) { return {result:{error:String(error),name:error.name}} }
    });
  }`)
  const input = {name:'example',storageId:'example@contract',pluginRoot:root,entrypoints:[path]}
  const declaration = await loadModDeclaration(input)
  expect(declaration.calls).toContain(op)
  const diagnostics: unknown[] = []
  runtime = createModsRuntime({onDiagnostic:event=>diagnostics.push(event)})
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:false,sessionId:'core-contract'})
  await runtime.reconcile([input])
  const result = await runtime.dispatch('tool.call', {}, async () => ({result:{missed:true}})) as {result:{returned?:boolean;error?:string;name?:string;missed?:boolean}}
  expect(result.result.missed).toBeUndefined()
  expect(result.result.returned === true || typeof result.result.error === 'string').toBe(true)
  if (result.result.error) {
    expect(result.result.name).toMatch(/^(Error|TypeError|HooksError)$/)
    expect(result.result.error).not.toMatch(/withdrawn|Unsupported host capability|absent from scan|not a function/)
  }
  expect(diagnostics).toEqual([])
})
