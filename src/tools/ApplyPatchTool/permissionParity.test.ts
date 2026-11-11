import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'

// apply_patch is an alias of Edit/Write for permissions: a patch must get the
// same decision as the Edit (update, delete) and Write (add, move target)
// calls it stands for, in every mode and for every rule shape.

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getCwdState, getOriginalCwd, setCwdState, setOriginalCwd } = await import('../../bootstrap/state.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { hasPermissionsToUseTool } = await import('../../utils/permissions/permissions.js')
const { FileEditTool } = await import('../FileEditTool/FileEditTool.js')
const { FileWriteTool } = await import('../FileWriteTool/FileWriteTool.js')
const { ApplyPatchTool } = await import('./ApplyPatchTool.js')

const project = realpathSync(mkdtempSync(join(tmpdir(), 'apply-patch-permission-parity-')))
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'apply-patch-permission-outside-')))
const savedCwd = getCwdState()
const savedOriginalCwd = getOriginalCwd()
setOriginalCwd(project)
setCwdState(project)
afterAll(() => {
  setOriginalCwd(savedOriginalCwd)
  setCwdState(savedCwd)
  rmSync(project, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

mkdirSync(join(project, 'src'))
mkdirSync(join(project, 'docs'))
for (const f of ['src/a.ts', 'src/m.ts', 'docs/gone.md', '.bashrc']) writeFileSync(join(project, f), 'old\n')
writeFileSync(join(outside, 'o.txt'), 'old\n')

type Op =
  | { type: 'update'; path: string; movePath?: string }
  | { type: 'add'; path: string }
  | { type: 'delete'; path: string }

const OPS: Record<string, Op> = {
  update: { type: 'update', path: join(project, 'src/a.ts') },
  add: { type: 'add', path: join(project, 'src/new.ts') },
  addDocs: { type: 'add', path: join(project, 'docs/new.md') },
  delete: { type: 'delete', path: join(project, 'docs/gone.md') },
  move: { type: 'update', path: join(project, 'src/m.ts'), movePath: join(project, 'docs/m.ts') },
  outside: { type: 'update', path: join(outside, 'o.txt') },
  dotfile: { type: 'update', path: join(project, '.bashrc') },
}

const PATCHES: Record<string, Op[]> = {
  ...Object.fromEntries(Object.entries(OPS).map(([k, op]) => [k, [op]])),
  'update+add': [OPS.update!, OPS.add!],
  'update+delete+move': [OPS.update!, OPS.delete!, OPS.move!],
  'src+docs': [OPS.update!, OPS.addDocs!],
  'update+outside': [OPS.update!, OPS.outside!],
  'add+dotfile': [OPS.add!, OPS.dotfile!],
}

function patchText(ops: Op[]): string {
  const body = ops.map(op => {
    if (op.type === 'add') return `*** Add File: ${op.path}\n+new`
    if (op.type === 'delete') return `*** Delete File: ${op.path}`
    return `*** Update File: ${op.path}${op.movePath ? `\n*** Move to: ${op.movePath}` : ''}\n-old\n+new`
  })
  return `*** Begin Patch\n${body.join('\n')}\n*** End Patch`
}

// The Edit/Write calls a patch stands for, as patchHookSteps maps them.
function equivalentCalls(ops: Op[]): [Tool, Record<string, unknown>][] {
  return ops.flatMap((op): [Tool, Record<string, unknown>][] => {
    const edit = (file_path: string): [Tool, Record<string, unknown>] => [FileEditTool as Tool, { file_path, old_string: 'old', new_string: 'new' }]
    const write = (file_path: string): [Tool, Record<string, unknown>] => [FileWriteTool as Tool, { file_path, content: 'new\n' }]
    if (op.type === 'add') return [write(op.path)]
    if (op.type === 'delete') return [edit(op.path)]
    return op.movePath ? [write(op.movePath), edit(op.path)] : [edit(op.path)]
  })
}

const RULES: Record<string, { allow?: string[]; deny?: string[]; ask?: string[] }> = {
  none: {},
  'allow Edit': { allow: ['Edit'] },
  'allow Write': { allow: ['Write'] },
  'allow Edit,Write': { allow: ['Edit', 'Write'] },
  'deny Edit': { deny: ['Edit'] },
  'deny Write': { deny: ['Write'] },
  'ask Edit': { ask: ['Edit'] },
  'ask Write': { ask: ['Write'] },
  'allow Edit,Write + ask Write': { allow: ['Edit', 'Write'], ask: ['Write'] },
  'allow Edit(src/**)': { allow: ['Edit(src/**)'] },
  'allow Edit(docs/**)': { allow: ['Edit(docs/**)'] },
  'deny Edit(docs/**)': { deny: ['Edit(docs/**)'] },
  'ask Edit(src/**)': { ask: ['Edit(src/**)'] },
  'allow Edit,Write + deny Edit(docs/**)': { allow: ['Edit', 'Write'], deny: ['Edit(docs/**)'] },
  'allow Edit,Write + ask Edit(src/**)': { allow: ['Edit', 'Write'], ask: ['Edit(src/**)'] },
  'allow Edit(//outside/**)': { allow: [`Edit(/${outside}/**)`] },
}

// auto needs the classifier, which a unit test cannot reach.
const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'] as const

function context(
  mode: (typeof MODES)[number],
  rules: { allow?: string[]; deny?: string[]; ask?: string[] },
  source = 'session',
): ToolUseContext {
  const initial = getDefaultAppState()
  const toolPermissionContext = {
    ...initial.toolPermissionContext,
    mode,
    isBypassPermissionsModeAvailable: mode === 'bypassPermissions',
    alwaysAllowRules: { [source]: rules.allow ?? [] },
    alwaysDenyRules: { [source]: rules.deny ?? [] },
    alwaysAskRules: { [source]: rules.ask ?? [] },
  } as ToolPermissionContext
  const state = { ...initial, toolPermissionContext }
  return {
    getAppState: () => state,
    setAppState: () => {},
    abortController: new AbortController(),
    options: { isNonInteractiveSession: false, tools: [FileEditTool, FileWriteTool, ApplyPatchTool] },
  } as unknown as ToolUseContext
}

async function decide(tool: Tool, input: Record<string, unknown>, ctx: ToolUseContext): Promise<string> {
  const result = await hasPermissionsToUseTool(tool, input, ctx, undefined as never, 'parity')
  return result.behavior
}

async function expectParity(ctx: ToolUseContext, ops: Op[]) {
  const per = await Promise.all(equivalentCalls(ops).map(([tool, input]) => decide(tool, input, ctx)))
  const expected = per.includes('deny') ? 'deny' : per.includes('ask') ? 'ask' : 'allow'
  expect({ per, got: await decide(ApplyPatchTool as Tool, { input: patchText(ops) }, ctx) }).toEqual({ per, got: expected })
}

const cases = MODES.flatMap(mode =>
  Object.keys(RULES).flatMap(rules => Object.keys(PATCHES).map(patch => [mode, rules, patch] as const)),
)

test.each(cases)('%s / %s / %s: apply_patch decides like its Edit/Write calls', async (mode, rules, patch) => {
  await expectParity(context(mode, RULES[rules]!), PATCHES[patch]!)
})

// Rules from every settings source and the CLI flags are matched the same way.
const SOURCES = ['userSettings', 'projectSettings', 'localSettings', 'policySettings', 'flagSettings', 'cliArg', 'command']
const sourceCases = SOURCES.flatMap(source =>
  ['allow Edit,Write', 'deny Write', 'ask Edit', 'allow Edit(src/**)', 'deny Edit(docs/**)'].flatMap(rules =>
    ['update+add', 'update+delete+move', 'src+docs'].map(patch => [source, rules, patch] as const),
  ),
)

test.each(sourceCases)('%s / %s / %s: rules from each source apply to apply_patch', async (source, rules, patch) => {
  await expectParity(context('default', RULES[rules]!, source), PATCHES[patch]!)
})
